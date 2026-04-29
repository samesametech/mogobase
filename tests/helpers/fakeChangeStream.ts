import { EventEmitter } from "events"

export class FakeChangeStream extends EventEmitter {
  closed = false
  async close() {
    this.closed = true
    this.emit("close")
  }
  emitChange(doc: any, type: "insert" | "update" | "delete" = "update") {
    this.emit("change", {
      operationType: type,
      fullDocument: type === "delete" ? undefined : doc,
      documentKey: { _id: doc?._id },
    })
  }
  emitError(err: Error) {
    this.emit("error", err)
  }
}

export type FakeStreamFactory = (model: string) => FakeChangeStream

export function makeFakeStreamFactory() {
  const opened: Record<string, FakeChangeStream[]> = {}
  const factory: FakeStreamFactory = (model) => {
    const cs = new FakeChangeStream()
    opened[model] = opened[model] || []
    opened[model].push(cs)
    return cs
  }
  return { factory, opened }
}
