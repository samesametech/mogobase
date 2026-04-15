// Default offline backend: RxDB + Dexie. This file exists so that
//   import ClientDB from "mogobase/client-db"
//   await import("./db")              // inside the provider
// keep resolving after the backend implementations moved into subfolders.
// The WatermelonDB backend lives at ./watermelon.

export * from "./rxdb"
export { default } from "./rxdb"
