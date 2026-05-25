import mongoose from 'mongoose';
import logger from '../utils/logger.js';
import { bindErrorContext, captureException, withMonitoringSpan } from '../monitoring/index.js';

// Enable debug mode in development
if (process.env.NODE_ENV === 'development') {
  mongoose.set('debug', (collectionName, method, query, doc) => {
    logger.debug(`${collectionName}.${method}`, JSON.stringify(query), doc || '');
  });
}

// Set mongoose options
mongoose.set('strictQuery', true);

const dbConnection = async () => {
  try {
    const conn = await withMonitoringSpan(
      "mongodb.connect",
      {
        op: "db.connect",
        attributes: {
          "db.system": "mongodb",
        },
      },
      () =>
        mongoose.connect(process.env.MONGODB_URI, {
          serverSelectionTimeoutMS: 5000, // Timeout after 5s instead of 30s
        }),
    );

    logger.info(`MongoDB Connected: ${conn.connection.host}`);
    
    // Handle connection events
    mongoose.connection.on('connected', () => {
      logger.info('Mongoose connected to DB');
    });

    mongoose.connection.on('error', (err) => {
      logger.error(`Mongoose connection error: ${err.message}`);
      captureException(
        err,
        bindErrorContext({
          tags: { area: 'mongodb', event: 'connection-error' },
          extra: {
            host: mongoose.connection.host || null,
          },
        }),
      );
    });

    mongoose.connection.on('disconnected', () => {
      logger.warn('Mongoose disconnected from DB');
    });

    // Handle process termination
    process.on('SIGINT', async () => {
      await mongoose.connection.close();
      logger.info('Mongoose default connection disconnected through app termination');
      process.exit(0);
    });

    return mongoose.connection;
  } catch (error) {
    logger.error(`MongoDB connection error: ${error.message}`);
    captureException(
      error,
      bindErrorContext({
        tags: { area: 'mongodb', event: 'startup-connection-error' },
      }),
    );
    process.exit(1);
  }
};

export { mongoose };
export default dbConnection;
