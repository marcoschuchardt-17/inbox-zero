// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { cleanup, render, screen } from "@testing-library/react";
import { createElement, Component, Suspense, type ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  createFromReadableStream,
} = require("next/dist/compiled/react-server-dom-webpack/client.node");

afterEach(cleanup);

describe("closed Flight streams", () => {
  it("turns an unfinished row into React's connection-closed error", async () => {
    const element = await createFromReadableStream(partialRowStream(), {
      serverConsumerManifest: emptyManifest(),
    });

    render(
      createElement(
        Boundary,
        null,
        createElement(Suspense, { fallback: "pending" }, element),
      ),
    );

    expect(screen.getByText("error:Connection closed.")).toBeTruthy();
  });

  it("leaves an unfinished row suspended when the stream is allowed to end early", async () => {
    const element = await createFromReadableStream(partialRowStream(), {
      serverConsumerManifest: emptyManifest(),
      unstable_allowPartialStream: true,
    });

    render(
      createElement(
        Boundary,
        null,
        createElement(Suspense, { fallback: "pending" }, element),
      ),
    );

    expect(screen.getByText("pending")).toBeTruthy();
    expect(screen.queryByText(/Connection closed/)).toBeNull();
  });
});

describe("Next decodes closed Flight streams without replacing the page", () => {
  it("allows the initial document, navigations, and server actions to end early", () => {
    const appIndex = readNextClient("app-index.js");
    const initialDecode = appIndex.slice(
      appIndex.indexOf("createFromReadableStream(readable"),
    );
    expect(initialDecode.slice(0, 600)).toContain(
      "unstable_allowPartialStream: true",
    );

    const navigation = readNextClient(
      "components/router-reducer/fetch-server-response.js",
    );
    const navigationDecode = navigation.slice(
      navigation.indexOf("function createFromNextFetch"),
    );
    expect(navigationDecode.slice(0, 700)).toContain(
      "unstable_allowPartialStream: true",
    );

    const action = readNextClient(
      "components/router-reducer/reducers/server-action-reducer.js",
    );
    const actionDecode = action.slice(
      action.indexOf("createFromFetch(responsePromise"),
    );
    expect(actionDecode.slice(0, 700)).toContain(
      "unstable_allowPartialStream: true",
    );
  });
});

class Boundary extends Component<
  { children: ReactNode },
  { message: string | null }
> {
  state = { message: null as string | null };

  static getDerivedStateFromError(error: Error) {
    return { message: error.message };
  }

  render() {
    if (this.state.message) return `error:${this.state.message}`;
    return this.props.children;
  }
}

function partialRowStream() {
  const row = '0:["$","span",null,{"children":"$1"}]\n';
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(row));
      controller.close();
    },
  });
}

function emptyManifest() {
  return {
    moduleMap: new Map(),
    serverModuleMap: new Map(),
    moduleLoading: { prefix: "" },
  };
}

function readNextClient(path: string) {
  return readFileSync(require.resolve(`next/dist/client/${path}`), "utf8");
}
