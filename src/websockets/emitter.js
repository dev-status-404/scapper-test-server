import { getSubscribers } from "./event.js";

export function emitEvent(io, eventType, payload) {
  const subscribers = getSubscribers(eventType);
  if (subscribers.size > 0) {
    io.to(eventType).emit("event", payload); 
  }
}