export function createDeadLetterService(outbox) {
  return Object.freeze({
    get: (eventId) => outbox.getDeadLetter(eventId),
    list: (options) => outbox.listDeadLetters(options),
    requeue: (eventId, options) => outbox.requeueDeadLetter(eventId, options),
    count: () => outbox.getDeadLetterCount(),
  });
}
