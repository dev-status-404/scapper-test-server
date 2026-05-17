const subscriptions = new Map();
export function subscribe(socket, eventType) {
  if (!subscriptions.has(eventType)) subscriptions.set(eventType, new Set());
  subscriptions.get(eventType).add(socket.id);
  socket.join(eventType);
}

export function unsubscribe(socket, eventType) {
  if (subscriptions.has(eventType)) {
    subscriptions.get(eventType).delete(socket.id);
    socket.leave(eventType);
  }
}

export function getSubscribers(eventType) {
  return subscriptions.get(eventType) || new Set();
}