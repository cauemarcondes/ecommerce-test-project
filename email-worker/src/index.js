"use strict";

// Load OpenTelemetry instrumentation first
require("./instrumentation");

const amqp = require("amqplib");
const { Client } = require("@elastic/elasticsearch");
const nodemailer = require("nodemailer");
const {
  trace,
  context,
  SpanStatusCode,
  propagation,
  SpanKind,
} = require("@opentelemetry/api");
const pino = require("pino");

// Environment variables
const RABBITMQ_URL = process.env.RABBITMQ_URL || "amqp://rabbitmq:5672";
const ELASTICSEARCH_URL =
  process.env.ELASTICSEARCH_URL || "http://elasticsearch:9200";
const SERVICE_NAME = process.env.OTEL_SERVICE_NAME || "email-worker";
const SERVICE_VERSION = process.env.SERVICE_VERSION || "0.1.0";

// Initialize tracer
const tracer = trace.getTracer("email-worker-tracer");

// Initialize logger with ECS formatting
const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  timestamp: () => `,"@timestamp":"${new Date().toISOString()}"`,
  formatters: {
    level(label) {
      return { log: { level: label } };
    },
  },
  base: {
    service: {
      name: SERVICE_NAME,
      version: SERVICE_VERSION,
    },
    event: {
      dataset: "email.log",
    },
  },
});

// Helper to add trace context to logs
function addTraceContext(span, log = {}) {
  if (!span || !span.spanContext) return log;

  const spanContext = span.spanContext();
  if (spanContext.traceId) {
    return {
      ...log,
      trace: { id: spanContext.traceId },
      span: { id: spanContext.spanId },
    };
  }
  return log;
}

// Helper to extract span context from traceparent
function extractSpanContextFromTraceparent(traceparent) {
  if (!traceparent) return null;

  // Create a carrier object with the traceparent
  const carrier = { traceparent };

  // Extract the context using a ROOT context to ensure we don't inherit the current context
  return propagation.extract(context.ROOT_CONTEXT, carrier);
}

// Initialize Elasticsearch client
const esClient = new Client({
  node: ELASTICSEARCH_URL,
});

// Setup test email transport (for simulation only)
const emailTransport = nodemailer.createTransport({
  host: "localhost",
  port: 25,
  secure: false,
  tls: {
    rejectUnauthorized: false,
  },
  // This is a simulation - no actual emails will be sent
  streamTransport: true,
  newline: "unix",
});

// Get order from Elasticsearch
async function getOrderFromES(orderId, span) {
  return tracer.startActiveSpan("ES /orders/_doc", async (esSpan) => {
    try {
      esSpan.setAttribute("order.id", orderId);

      // Get document
      const res = await esClient.get({
        index: "orders",
        id: orderId,
      });

      // Return order data
      return res._source;
    } catch (err) {
      if (err.meta && err.meta.statusCode === 404) {
        esSpan.setStatus({
          code: SpanStatusCode.ERROR,
          message: `Order not found: ${orderId}`,
        });

        logger.warn(
          addTraceContext(esSpan, {
            message: `Order not found: ${orderId}`,
            order: { id: orderId },
            error: { message: err.message },
          })
        );

        return null;
      }

      esSpan.recordException(err);
      esSpan.setStatus({
        code: SpanStatusCode.ERROR,
        message: err.message,
      });

      logger.error(
        addTraceContext(esSpan, {
          message: `Error retrieving order ${orderId}`,
          order: { id: orderId },
          error: { message: err.message, stack: err.stack },
        })
      );

      throw err;
    } finally {
      esSpan.end();
    }
  });
}

// Simulate sending an email
async function sendEmail(order, span) {
  return tracer.startActiveSpan(
    "send_confirmation_email",
    async (emailSpan) => {
      try {
        emailSpan.setAttribute("email.recipient", order.customerEmail);
        emailSpan.setAttribute(
          "email.subject",
          `Your order #${order.id} has been confirmed`
        );
        emailSpan.setAttribute("order.id", order.id);
        emailSpan.setAttribute("order.amount", order.amount);

        // Generate email content
        const emailContent = {
          from: '"Mini Shop" <noreply@minishop.example.com>',
          to: order.customerEmail,
          subject: `Your order #${order.id} has been confirmed`,
          text: `Thank you for your order #${order.id}!\n\nYour order for ${
            order.quantity
          }x ${
            order.productName
          } has been confirmed and paid.\nTotal: $${order.amount.toFixed(
            2
          )}\n\nThank you for shopping with us!\nMini Shop Team`,
          html: `
          <h1>Thank you for your order #${order.id}!</h1>
          <p>Your order has been confirmed and paid:</p>
          <ul>
            <li><strong>Product:</strong> ${order.productName}</li>
            <li><strong>Quantity:</strong> ${order.quantity}</li>
            <li><strong>Total:</strong> $${order.amount.toFixed(2)}</li>
          </ul>
          <p>Thank you for shopping with us!</p>
          <p>Mini Shop Team</p>
        `,
        };

        // Simulate email sending with small delay
        await new Promise((resolve) => setTimeout(resolve, 50));

        // Log email sending (in production, you would actually send the email)
        const logInfo = {
          message: `Sent email to ${order.customerEmail} for order ${order.id}`,
          order: {
            id: order.id,
            amount: order.amount,
            email: order.customerEmail,
          },
          email: {
            status: "sent",
            recipient: order.customerEmail,
            subject: emailContent.subject,
            content_type: "text/html",
          },
        };

        logger.info(addTraceContext(emailSpan, logInfo));

        emailSpan.setStatus({
          code: SpanStatusCode.OK,
          message: "Email sent successfully",
        });

        return true;
      } catch (err) {
        emailSpan.recordException(err);
        emailSpan.setStatus({
          code: SpanStatusCode.ERROR,
          message: err.message,
        });

        logger.error(
          addTraceContext(emailSpan, {
            message: `Failed to send email for order ${order.id}`,
            order: { id: order.id },
            error: { message: err.message, stack: err.stack },
          })
        );

        throw err;
      } finally {
        emailSpan.end();
      }
    }
  );
}

// Process order confirmed message
async function processOrderConfirmed(msg, channel, parentContext = null) {
  // Prepare options for the span, including any links to the parent context
  const spanOptions = {
    kind: SpanKind.CONSUMER,
    root: true, // Force creation of a root span with new trace ID
  };

  // Add span link if we have a parent context
  if (parentContext) {
    spanOptions.links = [
      {
        context: parentContext,
      },
    ];

    // Log the linking for debugging
    logger.info({
      message: "Creating span link to parent trace",
      parentTraceId: parentContext.traceId,
      parentSpanId: parentContext.spanId,
    });
  }

  // Force a new context to break trace propagation
  return context.with(context.ROOT_CONTEXT, () => {
    return tracer.startActiveSpan(
      "process_order_confirmed_message",
      spanOptions,
      async (span) => {
        try {
          // Parse message content
          const content = msg.content.toString();
          const order = JSON.parse(content);

          span.setAttribute("order.id", order.id);

          logger.info(
            addTraceContext(span, {
              message: `Received order.confirmed message for order ${order.id}`,
              order: { id: order.id },
            })
          );

          // Get order details from Elasticsearch
          const orderDetails = await getOrderFromES(order.id, span);

          if (!orderDetails) {
            // Acknowledge the message even if order not found, to avoid reprocessing
            channel.ack(msg);
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: `Order not found: ${order.id}`,
            });
            return;
          }

          // Send confirmation email
          await sendEmail(orderDetails, span);

          // Acknowledge the message
          channel.ack(msg);

          span.setStatus({
            code: SpanStatusCode.OK,
            message: "Order confirmation processed successfully",
          });

          logger.info(
            addTraceContext(span, {
              message: `Successfully processed order ${order.id}`,
              order: { id: order.id },
            })
          );
        } catch (err) {
          span.recordException(err);
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: err.message,
          });

          // Reject the message (requeue for retry)
          channel.nack(msg, false, true);

          logger.error(
            addTraceContext(span, {
              message: "Failed to process message",
              error: { message: err.message, stack: err.stack },
            })
          );
        } finally {
          span.end();
        }
      }
    );
  });
}

// Connect to RabbitMQ and start consuming messages
async function startConsumer() {
  let connection;
  let channel;
  let maxRetries = 10;
  let retryCount = 0;

  // Retry RabbitMQ connection
  while (retryCount < maxRetries) {
    try {
      logger.info({
        message: `Connecting to RabbitMQ at ${RABBITMQ_URL} (attempt ${
          retryCount + 1
        }/${maxRetries})`,
      });

      connection = await amqp.connect(RABBITMQ_URL);
      break;
    } catch (err) {
      retryCount++;
      logger.error({
        message: `Failed to connect to RabbitMQ (attempt ${retryCount}/${maxRetries})`,
        error: { message: err.message, stack: err.stack },
      });

      if (retryCount >= maxRetries) {
        throw err;
      }

      // Wait before retrying
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  // Setup error handler
  connection.on("error", (err) => {
    logger.error({
      message: "RabbitMQ connection error",
      error: { message: err.message, stack: err.stack },
    });
  });

  connection.on("close", () => {
    logger.info({
      message: "RabbitMQ connection closed",
    });
  });

  // Create channel
  channel = await connection.createChannel();

  // Declare exchange
  await channel.assertExchange("orders", "topic", {
    durable: true,
  });

  // Declare queue
  const queue = await channel.assertQueue("order.confirmed", {
    durable: true,
  });

  // Bind queue to exchange
  await channel.bindQueue(queue.queue, "orders", "order.confirmed");

  // Set prefetch count
  await channel.prefetch(1);

  // Start consuming messages
  await channel.consume(queue.queue, async (msg) => {
    if (msg) {
      // Extract tracing headers if present
      const headers = msg.properties.headers || {};
      const traceparent = headers.traceparent;

      if (traceparent) {
        try {
          // Parse the traceparent directly to extract span context
          // Format: 00-traceId-spanId-flags
          const parts = traceparent.split("-");
          if (parts.length === 4) {
            const parentTraceId = parts[1];
            const parentSpanId = parts[2];

            // Create a link to the parent span
            const parentSpanContext = {
              traceId: parentTraceId,
              spanId: parentSpanId,
              isRemote: true,
              traceFlags: parseInt(parts[3], 16),
            };

            logger.info({
              message: "Extracted parent context from traceparent",
              traceparent,
              parentTraceId,
              parentSpanId,
            });

            // Process the message with a new trace but link to the parent
            await processOrderConfirmed(msg, channel, parentSpanContext);
          } else {
            logger.warn({
              message: "Invalid traceparent format",
              traceparent,
            });
            await processOrderConfirmed(msg, channel);
          }
        } catch (err) {
          logger.error({
            message: "Error extracting span context",
            error: { message: err.message, stack: err.stack },
          });
          await processOrderConfirmed(msg, channel);
        }
      } else {
        // Process without trace context
        await processOrderConfirmed(msg, channel);
      }
    }
  });

  logger.info({
    message: "Email worker started and waiting for messages",
    service: {
      name: SERVICE_NAME,
      version: SERVICE_VERSION,
    },
    rabbitmq: {
      queue: "order.confirmed",
      exchange: "orders",
      routing_key: "order.confirmed",
    },
  });

  // Handle graceful shutdown
  const shutdown = async () => {
    logger.info({ message: "Shutting down email worker" });

    try {
      if (channel) await channel.close();
      if (connection) await connection.close();
      logger.info({ message: "Successfully closed RabbitMQ connections" });
    } catch (err) {
      logger.error({
        message: "Error during shutdown",
        error: { message: err.message, stack: err.stack },
      });
    }

    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return { connection, channel };
}

// Start the worker
async function main() {
  try {
    await startConsumer();
  } catch (err) {
    logger.fatal({
      message: "Failed to start email worker",
      error: { message: err.message, stack: err.stack },
    });
    process.exit(1);
  }
}

// Start the application
main();
