# Order API Documentation

This document provides information about the Order API implementation for the Woow backend.

## Overview

The Order API allows users to place orders for products. It includes:

- Validation of product availability
- Calculation of order total
- Processing payments via Stripe
- Storing order and order product details
- Transaction management to ensure data integrity

## Setup

1. Install the required dependencies:
   ```bash
   npm install
   ```

2. Configure environment variables:
   - Copy `.env.example` to `.env`
   - Add your Stripe API keys:
     ```
     STRIPE_SECRET_KEY=sk_test_your_stripe_secret_key
     STRIPE_WEBHOOK_SECRET=whsec_your_stripe_webhook_secret
     STRIPE_CURRENCY=usd
     ```

3. Run the application:
   ```bash
   npm run dev
   ```

## API Endpoints

### Create Setup Intent

**Endpoint:** `POST /api/order/create-card-token`

**Authentication:** Required (User or Admin)

**Request Body:**
No request body needed

**Response:**
```json
{
    "code": 200,
    "success": true,
    "message": "Setup intent created successfully",
    "data": {
        "client_secret": "seti_1S7eTlLID0xGqXibUcCnu4hT_secret_AbCdEfGhIjKlMnOpQrStUvWxYz",
        "setup_intent_id": "seti_1S7eTlLID0xGqXibUcCnu4hT"
    }
}
```

> **Important**: The client_secret should be used with Stripe.js on the client side to securely collect card details. Never send raw card data to your server.

### Retrieve Payment Method

**Endpoint:** `POST /api/order/retrieve-payment-method`

**Authentication:** Required (User or Admin)

**Request Body:**
```json
{
    "payment_method_id": "pm_1S7eTlLID0xGqXibUcCnu4hT"
}
```

**Response:**
```json
{
    "code": 200,
    "success": true,
    "message": "Payment method retrieved successfully",
    "data": {
        "payment_method": {
            "id": "pm_1S7eTlLID0xGqXibUcCnu4hT",
            "card": {
                "last4": "4242",
                "brand": "Visa",
                "exp_month": 3,
                "exp_year": 2029
            }
        }
    }
}
```

### Place Order

**Endpoint:** `POST /api/order/place-order`

**Authentication:** Required (User or Admin)

**Request Body:**
```json
{
    "products": [
        {
            "product_id": 212,
            "qty": 1
        },
        {
            "product_id": 213,
            "qty": 2
        }
    ],
    "payment_method_id": "pm_1S7eTlLID0xGqXibUcCnu4hT",
    "device": "WEB"
}
```

**Response:**
```json
{
    "code": 200,
    "success": true,
    "message": "Order placed successfully",
    "data": {
        "order_id": 123,
        "total": 99.99,
        "payment_id": "ch_1S7eTlLID0xGqXibUcCnu4hT"
    }
}
```

## Implementation Details

### Secure Card Handling

This implementation follows Stripe's recommended best practices for secure card handling:

1. **Client-Side Tokenization**:
   - The server provides a Setup Intent with a client secret
   - Card details are collected and tokenized directly on the client using Stripe.js
   - Only the resulting payment method ID is sent to the server
   - Raw card data never touches your server

2. **Payment Method Management**:
   - Payment methods can be retrieved to display saved card information
   - Only non-sensitive data (last 4 digits, brand, expiration) is returned

### Order Placement Process

The order placement process follows these steps:

1. **Validation**:
   - Verify that products array is provided and not empty
   - Verify that payment method ID is provided
   - Check if each product exists
   - Validate that requested quantity doesn't exceed available stock

2. **Transaction Management**:
   - Start a database transaction
   - Fetch all products in one query for efficiency
   - Calculate total order amount
   - Update product quantities
   - Process payment with Stripe using Payment Intents API
   - Create order record
   - Create order product records
   - Commit transaction on success
   - Rollback transaction on failure

3. **Error Handling**:
   - Custom error messages with appropriate status codes
   - Transaction rollback on any error
   - Detailed logging for troubleshooting

## Models

### Order Model
- `id`: Primary key
- `user_id`: Foreign key to User
- `stripe_payment_id`: Stripe payment ID
- `total`: Order total amount
- `status`: Order status (0 = pending, 1 = completed)
- `device`: Device used to place order
- `created`: Creation timestamp

### OrderProduct Model
- `id`: Primary key
- `order_id`: Foreign key to Order
- `product_id`: Foreign key to Product
- `product_title`: Product title at time of order
- `product_price`: Product price at time of order
- `product_quantity`: Quantity ordered
- `product_image`: Product image URL
- `product_attritube_combination`: JSON string of product attributes

## Stripe Integration

The API uses Stripe for payment processing with a focus on security and PCI compliance:

### Client-Side Implementation

On the client side, you should:

1. Request a Setup Intent from the server using the `/create-card-token` endpoint
2. Use Stripe.js and the client secret to collect and tokenize card details:

```javascript
// Example client-side code using Stripe.js
const stripe = Stripe('pk_test_your_publishable_key');

// Get the client secret from your server
const { client_secret } = await fetchFromServer('/api/order/create-card-token');

// Use Stripe.js to collect card details and create a payment method
const { setupIntent, error } = await stripe.confirmCardSetup(client_secret, {
  payment_method: {
    card: cardElement, // A Stripe Element containing card details
    billing_details: {
      name: 'Customer Name',
    },
  },
});

if (error) {
  // Handle error
} else {
  // Use setupIntent.payment_method to place an order
  const paymentMethodId = setupIntent.payment_method;
  
  // Now you can place an order with this payment method ID
  const orderResponse = await fetchFromServer('/api/order/place-order', {
    products: [...],
    payment_method_id: paymentMethodId,
    device: 'WEB'
  });
}
```

### Server-Side Implementation

On the server side, the implementation:

1. Creates Setup Intents for secure card collection
2. Uses Payment Intents API for processing payments
3. Converts the order total to cents for Stripe
4. Processes the payment using the provided payment method ID
5. Stores the Stripe payment ID and transaction ID with the order
6. Provides comprehensive error handling for payment failures

## Error Handling

The API includes comprehensive error handling:

- Input validation errors (400 Bad Request)
- Product not found errors (404 Not Found)
- Insufficient stock errors (400 Bad Request)
- Payment processing errors (from Stripe)
- Database transaction errors

All errors include appropriate status codes and descriptive messages.
