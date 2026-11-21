// Lets standalone scripts (yarn db:*) import Deskverse's server modules.
//
// Next.js resolves the "server-only" marker itself, so the package isn't
// installed; outside Next.js the import would fail. Scripts are server-side
// by definition, so the marker resolves to an empty module here. This hook
// is only ever loaded by `node --import` in package.json's db:* scripts,
// never by the Next.js app.
import { registerHooks } from "node:module"

const EMPTY_MODULE = new URL("./server-only-stub.cjs", import.meta.url).href

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only")
      return { url: EMPTY_MODULE, shortCircuit: true }
    return nextResolve(specifier, context)
  },
})
