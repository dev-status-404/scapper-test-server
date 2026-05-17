# WOW Backend

A Node.js backend service built with Express and Sequelize.

## Features

- User authentication (register, login, refresh token, logout)
- Password reset via email
- Role-based access control
- Request validation
- Rate limiting
- Logging
- Environment configuration
- Database migrations and seeds

## Prerequisites

- Node.js 16+
- MySQL 8.0+
- npm or yarn

## Setup

1. Clone the repository
2. Install dependencies:
   ```bash
   npm install
   ```
3. Copy `.env.example` to `.env` and update the values
4. Start the development server:
   ```bash
   npm run dev
   ```

## Scripts

- `npm run dev` - Start development server with hot-reload
- `npm start` - Start production server
- `npm run lint` - Run ESLint

## API Documentation

API documentation is available at `/api-docs` when running in development mode.

## Development Roadmap

### Week 1: Foundation & Core Features (Phase 1)

- ✅ Memory optimizations
- ✅ Rate limiting
- ✅ Database indexes
- ✅ Follower tracking with relationship types

### Week 2: Performance Optimization

- ✅ Bulk scraping optimization (60% faster)
- ✅ API cost reduction (90% savings)
- ✅ Memory reduction (65% improvement)
- ✅ Browser stability fixes

### Week 3: Scalability & Queue System (Phase 2)

- Async job queue with Bull and Redis
- Handle 100+ concurrent scrape requests
- Automatic retries on failure
- WebSocket progress updates
- Upstash Redis integration

### Week 4: Multi-account Support (Phase 3)

- Multiple Instagram account rotation
- Account pool management
- Load balancing across accounts
- Account health monitoring
- Reduced rate limit impact
- Increased scraping throughput

### Future Enhancements

- Browser pooling with `generic-pool`
- Caching layer for profiles
- Horizontal scaling with PM2 cluster mode
- Advanced analytics dashboard

## License

MIT
