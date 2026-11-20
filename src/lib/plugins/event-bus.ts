export type EventBusHandler<Event> = (event: Event) => void

export class EventBus<Events extends object> {
  private readonly handlers = new Map<
    keyof Events,
    Set<EventBusHandler<Events[keyof Events]>>
  >()

  publish<Name extends keyof Events>(name: Name, event: Events[Name]): void {
    const handlers = this.handlers.get(name)
    if (!handlers) {
      return
    }

    for (const handler of Array.from(handlers)) {
      handler(event)
    }
  }

  subscribe<Name extends keyof Events>(
    name: Name,
    handler: EventBusHandler<Events[Name]>,
  ): () => void {
    let handlers = this.handlers.get(name)
    if (!handlers) {
      handlers = new Set<EventBusHandler<Events[keyof Events]>>()
      this.handlers.set(name, handlers)
    }

    const registeredHandler = handler as EventBusHandler<Events[keyof Events]>
    handlers.add(registeredHandler)

    return () => {
      handlers.delete(registeredHandler)
      if (handlers.size === 0) {
        this.handlers.delete(name)
      }
    }
  }
}
