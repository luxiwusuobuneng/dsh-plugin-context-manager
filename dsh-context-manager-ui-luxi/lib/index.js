// dsh-context-manager-ui-luxi — host half (deliberately empty).
//
// This package exists ONLY to deliver the context-manager browser UI through
// the web profile's client-module scan. clientModules discovers client
// bundles from LOADER entries (rows of the web composition), never from
// agent-preset rows — a preset-mounted client bundle is absent from
// `ctx.loader.entries()` and is therefore never served nor adopted by the
// kernel. Mounting this row in cordis.patch.yml makes the dock button and
// management window available in EVERY session; recording and message
// injection stay with the per-preset `dsh-context-manager-agent-luxi` row
// and the host-plane `contextManager` service.

export default {
  name: "dsh-context-manager-ui-luxi",
  apply() {
    // The browser half (./client.js) does all the work; nothing is needed
    // on the host side beyond the row itself.
  }
};
