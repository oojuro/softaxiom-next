import fs from "node:fs";
import path from "node:path";
import { isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { OpenAsyncKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import { createOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IMessageRpcClient } from "./client.js";
import { resolveIMessageRemoteHost } from "./remote-host.js";
import {
  createClient,
  createRejectingClient,
  createTimedOutSendClient,
  getClientMocks,
} from "./send.test-support.js";
import {
  createIMessageOutboundRpcFixture,
  entitySeparator,
  expectNoRoleMarkers,
  expectScrubbedRequests,
  fencedYaml,
  hiddenFunctionResponse,
  nestMarkdownFences,
  privateRuntimeBlocks,
  privateRuntimeScaffolding,
  rawSeparator,
  roles,
} from "./test-support/outbound-rpc.test-support.js";
import { loadFreshIMessageReplyCacheForTest } from "./test-support/runtime.js";

type ApprovalReactionsModule = typeof import("./approval-reactions.js");
type ClientModule = typeof import("./client.js");
type ErrorRuntimeModule = typeof import("openclaw/plugin-sdk/error-runtime");
type PersistedEchoCacheModule = typeof import("./monitor/persisted-echo-cache.js");
type ReplyCacheModule = typeof import("./monitor-reply-cache.js");
type SendModule = typeof import("./send.js");
let IMessageRpcRequestError: ClientModule["IMessageRpcRequestError"];
let PlatformMessageNotDispatchedError: ErrorRuntimeModule["PlatformMessageNotDispatchedError"];
let resolveIMessageApprovalReactionTargetWithPersistence: ApprovalReactionsModule["resolveIMessageApprovalReactionTargetWithPersistence"];
let hasPersistedIMessageEcho: PersistedEchoCacheModule["hasPersistedIMessageEcho"];
let rememberIMessageReplyCache: ReplyCacheModule["rememberIMessageReplyCache"];
let sendMessageIMessage: SendModule["sendMessageIMessage"];
let clientRuntime: ClientModule;
let mediaRuntime: typeof import("openclaw/plugin-sdk/media-runtime");
let cliOutput: typeof import("./cli-output.js");
let remoteFile: typeof import("./remote-file.js");
let chatDb: typeof import("./chat-db.js");

async function loadFreshSendModule(): Promise<void> {
  ({ rememberIMessageReplyCache } = await loadFreshIMessageReplyCacheForTest({
    reuseDatabase: true,
  }));
  ({ IMessageRpcRequestError } = await import("./client.js"));
  ({ PlatformMessageNotDispatchedError } = await import("openclaw/plugin-sdk/error-runtime"));
  ({ resolveIMessageApprovalReactionTargetWithPersistence } =
    await import("./approval-reactions.js"));
  ({ hasPersistedIMessageEcho } = await import("./monitor/persisted-echo-cache.js"));
  ({ sendMessageIMessage } = await import("./send.js"));
  clientRuntime = await import("./client.js");
  mediaRuntime = await import("openclaw/plugin-sdk/media-runtime");
  cliOutput = await import("./cli-output.js");
  remoteFile = await import("./remote-file.js");
  chatDb = await import("./chat-db.js");
}

const IMESSAGE_TEST_CFG = { channels: { imessage: { accounts: { default: {} } } } };

function createApprovalText(id = "approval-123"): string {
  return `Exec approval required\nID: ${id}\n\nReply with: /approve ${id} allow-once|deny`;
}

function createApprovalPrompt(id = "approval-123") {
  return {
    approvalId: id,
    approvalKind: "exec" as const,
    allowedDecisions: ["allow-once", "deny"] as const,
  };
}

describe("sendMessageIMessage receipts", () => {
  let openClawState: OpenClawTestState;

  beforeEach(async () => {
    openClawState = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-imessage-send-",
    });
    await loadFreshSendModule();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.useRealTimers();
    await openClawState.cleanup();
  });

  function createOutboundMediaFile(filename: string, contents: Buffer): string {
    const sourcePath = openClawState.path(filename);
    fs.writeFileSync(sourcePath, contents);
    return sourcePath;
  }

  function mockAttachment(value: { path: string; contentType?: string }) {
    return vi.spyOn(mediaRuntime, "resolveOutboundAttachmentFromUrl").mockResolvedValue(value);
  }

  function expectRequest(request: unknown, method: string, params: Record<string, unknown>) {
    expect(request).toHaveBeenCalledWith(
      method,
      expect.objectContaining(params),
      expect.any(Object),
    );
  }

  function attachmentArgs(chat: string, file: string, transport = "auto", extra: string[] = []) {
    return ["send-attachment", "--chat", chat, "--file", file, ...extra, "--transport", transport];
  }

  async function waitForStage(stage: Promise<void>, send: Promise<unknown>) {
    await Promise.race([
      stage,
      send.then(() => {
        throw new Error("Send settled before the awaited lifecycle stage");
      }),
    ]);
  }

  function mockCliSend() {
    const run = vi.fn<(args: readonly string[]) => Promise<Record<string, unknown>>>();
    vi.spyOn(cliOutput, "runIMessageCliJsonCommand").mockImplementation(({ args }) => run(args));
    return run;
  }

  // Parser permutations live in monitor.behavior's sanitize-outbound suite.
  // These cases prove the real RPC, channel, and CLI boundaries apply that policy.
  it("preserves channel rendering and rejects hidden markup before local RPC dispatch", async () => {
    const { cfg, deliver, countNativeRequests, readRequests, createChannelDelivery } =
      createIMessageOutboundRpcFixture(openClawState, sendMessageIMessage);
    const { deliverThroughChannel } = createChannelDelivery();
    await deliver(["assistant:", fencedYaml, rawSeparator, "assistant to=tool"].join("\n"));
    expect((await deliverThroughChannel(fencedYaml)).sanitized).toContain("```yaml");
    for (const role of roles) {
      expect(readRequests()[0]?.params.text).toMatch(new RegExp(`^${role}:$`, "m"));
    }
    for (const attribute of ["b>", "<tag>", "<previous_response>", "<!--"]) {
      const html = `<strong title="${attribute}">😀 bold</strong> <del data-note='${attribute}'>strike</del>`;
      expect((await deliverThroughChannel(html)).sanitized).toBe("**😀 bold** ~~strike~~");
      const params = readRequests().at(-1)?.params;
      for (const [style, text] of [
        ["bold", "😀 bold"],
        ["strikethrough", "strike"],
      ] as const) {
        const range = params?.formatting?.find((item) => item.styles.includes(style));
        expect(params?.text.slice(range?.start, (range?.start ?? 0) + (range?.length ?? 0))).toBe(
          text,
        );
      }
    }
    let expectedRequests = 6;
    const companion = privateRuntimeScaffolding + "\nvisible runtime companion";
    for (const send of [
      () => sendMessageIMessage("chat_id:10", companion, { config: cfg }),
      () => deliver(companion),
      () => deliverThroughChannel(companion),
    ]) {
      const before = countNativeRequests();
      await send();
      const added = readRequests().slice(before);
      expect(added.length).toBeGreaterThan(0);
      expect(
        added.some((request) => request.params.text.includes("visible runtime companion")),
      ).toBe(true);
      expectScrubbedRequests(added);
      expectedRequests += added.length;
    }
    for (const [source, reason] of [
      ["```xml\n<thinking>hidden</thinking>\n```", "hidden assistant content"],
      [nestMarkdownFences(hiddenFunctionResponse, 4), "hidden assistant content"],
      ["<<script>thinking>hidden</<script>thinking>", "ambiguous nested HTML"],
    ] as const) {
      const before = countNativeRequests();
      await expect(deliverThroughChannel(source)).rejects.toThrow(
        `iMessage outbound ${reason} is not allowed`,
      );
      expect(countNativeRequests()).toBe(before);
    }
    expect(readRequests()).toHaveLength(expectedRequests);
    expectNoRoleMarkers(readRequests().slice(2));
    expectScrubbedRequests(readRequests());
  }, 30_000);

  it("scrubs rich CLI text and preserves UTF-16 reply formatting", async () => {
    const { actionOptions: options, readActions } = createIMessageOutboundRpcFixture(
      openClawState,
      sendMessageIMessage,
    );
    const { imessageActionsRuntime: actions } = await import("./actions.runtime.js");
    await actions.sendRichMessage({
      chatGuid: options.chatGuid,
      options,
      replyToMessageId: "reply-message-guid",
      text: [
        "user:",
        "<thinking>HIDDEN_ACTION_THINKING</thinking>",
        hiddenFunctionResponse,
        privateRuntimeScaffolding,
        rawSeparator,
        "assistant to=tool",
        "**😀 reply styled**",
      ].join("\n"),
    });
    const [args] = readActions();
    expect(readActions()).toHaveLength(1);
    if (!args) {
      throw new Error("Expected native rich send");
    }
    const value = (flag: string) => args[args.indexOf(flag) + 1] ?? "";
    expect(value("--reply-to")).toBe("reply-message-guid");
    const text = value("--text");
    expect(text.trim()).toBe("😀 reply styled");
    const ranges = JSON.parse(value("--format")) as Array<{
      start: number;
      length: number;
      styles: string[];
    }>;
    const bold = ranges.find((range) => range.styles.includes("bold"));
    expect(text.slice(bold?.start, (bold?.start ?? 0) + (bold?.length ?? 0))).toBe(
      "😀 reply styled",
    );
  }, 30_000);

  it("rejects malformed, empty, and forged private content without native dispatch", async () => {
    const {
      cfg,
      actionOptions: options,
      deliver,
      readRequests,
      readActions,
      createChannelDelivery,
    } = createIMessageOutboundRpcFixture(openClawState, sendMessageIMessage);
    const { deliverThroughChannel } = createChannelDelivery();
    const { imessageActionsRuntime: actions } = await import("./actions.runtime.js");
    const chatGuid = options.chatGuid;
    const rpc = (text: string) => sendMessageIMessage("chat_id:10", text, { config: cfg });
    const rich = (text: string) => actions.sendRichMessage({ chatGuid, options, text });
    const edit = (text: string, backwardsCompatMessage?: string) =>
      actions.editMessage({
        chatGuid,
        options,
        messageId: "edit-message-guid",
        text,
        backwardsCompatMessage,
      });
    const poll = (question: string, choices: readonly string[]) =>
      actions.sendPoll({ chatGuid, options, question, choices });
    const emptyErrors = {
      send: "iMessage send requires text or media",
      rich: "iMessage rich send requires text or an attachment after sanitization",
      edit: "iMessage edit requires non-empty text after sanitization",
      poll: "iMessage poll requires a non-empty question and options after sanitization",
    };
    const routes = [
      { send: rpc, empty: emptyErrors.send },
      { send: rich, empty: emptyErrors.rich },
      { send: (text: string) => edit(text, "visible fallback"), empty: emptyErrors.edit },
      { send: (text: string) => edit("visible edit", text), empty: emptyErrors.edit },
      { send: (text: string) => poll(text, ["first", "second"]), empty: emptyErrors.poll },
      {
        send: (text: string) => poll("visible question", [text, "second"]),
        empty: emptyErrors.poll,
      },
    ];
    const malformed =
      "<system-reminder><system-reminder>inner</system-reminder>OUTER_PRIVATE_SECRET";
    const roleSwap =
      "```xml\n<thinking>\nuser:\n</thinking>\n```\n&#xE000;&#xE000;&lt;relevant_memories&gt;HIDDEN_ROLE_SWAP&lt;/relevant_memories&gt;&#xE000;&#xE000;:";
    for (const { send, empty } of routes) {
      for (const [source, error] of [
        [malformed, "iMessage outbound runtime markup is malformed"],
        [privateRuntimeBlocks.join("\n"), empty],
        [roleSwap, "iMessage outbound role protection failed"],
        [
          "`<thinking>hidden</thinking>`",
          "iMessage outbound hidden assistant content is not allowed",
        ],
        [
          nestMarkdownFences(hiddenFunctionResponse, 4),
          "iMessage outbound hidden assistant content is not allowed",
        ],
      ] as const) {
        await expect(send(source)).rejects.toThrow(error);
      }
    }
    for (const send of [deliver, deliverThroughChannel]) {
      await expect(send(malformed)).rejects.toThrow(
        "iMessage outbound runtime markup is malformed",
      );
    }
    for (const source of [
      fencedYaml + "\n" + "&#xE000;".repeat(4),
      "```yaml\nuser:\n```\n&#xE000;&#xE000;" + entitySeparator + "&#xE000;&#xE000;",
    ]) {
      await expect(rpc(source)).rejects.toThrow("iMessage outbound role protection failed");
      await expect(rich(source)).rejects.toThrow("iMessage outbound role protection failed");
    }
    await expect(poll("Choose one", ["Allow", `Al${rawSeparator}low`])).rejects.toThrow(
      "iMessage poll options must remain distinct after sanitization",
    );
    expect(readActions()).toHaveLength(0);
    expect(readRequests()).toHaveLength(0);
  }, 30_000);

  it.each(["guid", "failure"] as const)(
    "awaits owned RPC close before settling a %s send",
    async (outcome) => {
      const requestError = new Error("synthetic request failure");
      const rpc = createClient({ guid: "p:0/close-proof" });
      const mocks = vi.mocked(rpc);
      if (outcome === "failure") {
        mocks.request.mockRejectedValue(requestError);
      }
      const closing = createDeferred<void>();
      const releaseClose = createDeferred<void>();
      mocks.stop.mockImplementation(() => {
        closing.resolve();
        return releaseClose.promise;
      });
      let settled = false;
      vi.spyOn(clientRuntime, "createIMessageRpcClient").mockResolvedValue(rpc);
      const observed = sendMessageIMessage("chat_id:42", "close proof", {
        config: IMESSAGE_TEST_CFG,
      }).then(
        (value) => {
          settled = true;
          return { value };
        },
        (error: unknown) => {
          settled = true;
          return { error };
        },
      );
      try {
        await waitForStage(closing.promise, observed);
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(settled).toBe(false);
        expect(mocks.stop.mock.calls).toHaveLength(1);
        releaseClose.resolve();
        if (outcome === "failure") {
          await expect(observed).resolves.toEqual({ error: requestError });
        } else {
          await expect(observed).resolves.toMatchObject({
            value: {
              messageId: "p:0/close-proof",
              receipt: {
                platformMessageIds: ["p:0/close-proof"],
              },
            },
          });
        }
      } finally {
        releaseClose.resolve();
        await observed;
      }
    },
  );

  it.each(["owned", "borrowed"] as const)(
    "keeps %s client custody when options change during an accepted request",
    async (ownership) => {
      const started = createDeferred<void>();
      const response = createDeferred<Record<string, unknown>>();
      const rpc = createClient({ guid: "p:0/captured-owner" });
      const mocks = vi.mocked(rpc);
      mocks.request.mockImplementation(() => {
        started.resolve();
        return response.promise;
      });
      vi.spyOn(clientRuntime, "createIMessageRpcClient").mockResolvedValue(rpc);
      const options: Parameters<typeof sendMessageIMessage>[2] = {
        config: IMESSAGE_TEST_CFG,
        ...(ownership === "borrowed" ? { client: rpc } : {}),
      };
      const observed = sendMessageIMessage("chat_id:42", "captured ownership", options).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      try {
        await waitForStage(started.promise, observed);
        options.client = ownership === "owned" ? rpc : undefined;
        response.resolve({ guid: "p:0/captured-owner" });
        await expect(observed).resolves.toMatchObject({
          value: { messageId: "p:0/captured-owner" },
        });
        expect(mocks.stop.mock.calls).toHaveLength(ownership === "owned" ? 1 : 0);
      } finally {
        response.resolve({ guid: "p:0/captured-owner" });
        await observed;
      }
    },
  );

  it("preserves the default CLI attachment rejection", async () => {
    const cliPath = openClawState.path("fake-attachment-cli");
    const logPath = openClawState.path("attachment-cli-argv.jsonl");
    const dbPath = openClawState.path("unused-chat.db");
    const mediaPath = createOutboundMediaFile("fixture.pdf", Buffer.from("%PDF-1.4\nsynthetic"));
    const response = { success: false, error: "synthetic CLI rejection" };
    fs.writeFileSync(
      cliPath,
      [
        "#!" + process.execPath,
        'const fs = require("node:fs");',
        `fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(process.argv.slice(2)) + "\\n");`,
        `process.stdout.write(${JSON.stringify(JSON.stringify(response) + "\n")});`,
      ].join("\n"),
      { mode: 0o755 },
    );
    const createRpc = vi
      .spyOn(clientRuntime, "createIMessageRpcClient")
      .mockResolvedValue(createClient({ guid: "unexpected-rpc" }));
    mockAttachment({ path: mediaPath, contentType: "application/pdf" });
    const sending = sendMessageIMessage("chat_guid:fixture-chat", "", {
      config: { channels: { imessage: { accounts: { default: { cliPath, dbPath } } } } },
      mediaUrl: mediaPath,
    });
    await expect(sending).rejects.toThrow("synthetic CLI rejection");
    expect(createRpc).not.toHaveBeenCalled();
    const calls = fs
      .readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe("send-attachment");
  });

  it("joins pending echo persistence before sending and its rollback before rejecting", async () => {
    const { getIMessageRuntime } = await import("./runtime.js");
    const state = getIMessageRuntime().state;
    const openStore = state.openKeyedStoreV2.bind(state);
    const writeStarted = createDeferred<void>();
    const writeGate = createDeferred<void>();
    const deleteStarted = createDeferred<void>();
    const deleteGate = createDeferred<void>();
    const openSpy = vi
      .spyOn(state, "openKeyedStoreV2")
      .mockImplementation(<T>(options: OpenAsyncKeyedStoreOptions) => {
        const store = openStore<T>(options);
        if (options.namespace === "imessage.sent-echoes") {
          const register = store.register.bind(store);
          const remove = store.delete.bind(store);
          vi.spyOn(store, "register").mockImplementation(async (...args) => {
            writeStarted.resolve();
            await writeGate.promise;
            await register(...args);
          });
          vi.spyOn(store, "delete").mockImplementation(async (...args) => {
            deleteStarted.resolve();
            await deleteGate.promise;
            return await remove(...args);
          });
        }
        return store;
      });
    const client = createClient({ success: false, error: "recipient is not registered" });
    let settled = false;
    const send = sendMessageIMessage("+15551234567", "hello", {
      config: IMESSAGE_TEST_CFG,
      client,
    }).catch((error: unknown) => {
      settled = true;
      return error;
    });
    try {
      await waitForStage(writeStarted.promise, send);
      expect(getClientMocks(client).request).not.toHaveBeenCalled();
      writeGate.resolve();
      await waitForStage(deleteStarted.promise, send);
      expect(settled).toBe(false);
      deleteGate.resolve();
      expect(await send).toEqual(new Error("recipient is not registered"));
      expect(
        await hasPersistedIMessageEcho({
          scope: "default:imessage:+15551234567",
          text: "hello",
          includePendingText: true,
        }),
      ).toBe(false);
    } finally {
      writeGate.resolve();
      deleteGate.resolve();
      await send;
      openSpy.mockRestore();
    }
  });

  it("maps authoritative attachment pre-dispatch failure to retry-safe custody", async () => {
    const rpcError = new IMessageRpcRequestError("Delivery failed before dispatch", -32603, {
      retry_safe: true,
      disposition: "not_started",
      transport: "bridge_v2",
      operation: "send-attachment",
    });
    const client = createRejectingClient(rpcError);
    mockAttachment({ path: "/gateway/photo.png" });
    vi.spyOn(clientRuntime, "createIMessageRpcClient").mockResolvedValue(client);
    vi.spyOn(remoteFile, "withIMessageRemoteFile").mockImplementation(
      async (params) => await params.use("/tmp/openclaw-imessage-safe/photo.png"),
    );
    const rejection = await sendMessageIMessage("chat_id:42", "", {
      config: {
        channels: { imessage: { accounts: { default: { remoteHost: "work@messages-b" } } } },
      },
      mediaUrl: "/gateway/photo.png",
    }).catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(PlatformMessageNotDispatchedError);
    expect(rejection).toMatchObject({ message: rpcError.message, cause: rpcError });
    expect(getClientMocks(client).request).toHaveBeenCalledExactlyOnceWith(
      "send.attachment",
      expect.objectContaining({ file: "/tmp/openclaw-imessage-safe/photo.png" }),
      expect.any(Object),
    );
    expect(getClientMocks(client).stop).toHaveBeenCalledOnce();
  });

  it("keeps a missing retry-safe flag ambiguous", async () => {
    const rpcError = new IMessageRpcRequestError("Delivery outcome remains ambiguous", -32001, {
      disposition: "not_started",
    });
    const client = createRejectingClient(rpcError);

    const rejection = await sendMessageIMessage("chat_id:42", "hello", {
      config: IMESSAGE_TEST_CFG,
      client,
    }).catch((error: unknown) => error);

    expect(rejection).toBe(rpcError);
    expect(rejection).not.toBeInstanceOf(PlatformMessageNotDispatchedError);
  });

  it("drops disabled reply metadata from an attachment send", async () => {
    const client = createClient({ guid: "p:0/plain-guid" });
    const runCliJson = mockCliSend().mockResolvedValueOnce({ messageId: "p:0/plain-guid" });
    mockAttachment({ path: "/tmp/image.png", contentType: "image/png" });
    const result = await sendMessageIMessage("chat_guid:chat-1", "", {
      config: {
        channels: { imessage: { actions: { reply: false }, accounts: { default: {} } } },
      },
      client,
      replyToId: "p:0/reply-guid",
      mediaUrl: "/tmp/image.png",
    });
    expect(result.messageId).toBe("p:0/plain-guid");
    expect(result.receipt.replyToId).toBeUndefined();
    expect(result.receipt.parts[0]?.replyToId).toBeUndefined();
    expect(runCliJson.mock.calls).toEqual([
      [["send-attachment", "--chat", "chat-1", "--file", "/tmp/image.png", "--transport", "auto"]],
    ]);
    expect(getClientMocks(client).request).not.toHaveBeenCalled();
  });

  it("rejects an unbound delegated reply before media or provider access", async () => {
    const client = createClient({ guid: "should-not-send" });
    const resolveAttachment = mockAttachment({
      path: "/tmp/image.png",
      contentType: "image/png",
    });

    await expect(
      sendMessageIMessage("chat_id:42", "caption", {
        config: {
          channels: { imessage: { remoteHost: "qa@example.invalid", accounts: { default: {} } } },
        },
        client,
        conversationReadOrigin: "delegated",
        mediaUrl: "/tmp/image.png",
        replyToId: "unbound-reply-guid",
      }),
    ).rejects.toThrow("require a current same-account conversation binding");

    expect(resolveAttachment).not.toHaveBeenCalled();
    expect(getClientMocks(client).request).not.toHaveBeenCalled();
  });

  it.each([
    {
      target: "chat_id:42",
      replyToId: "bound-reply-guid",
      service: undefined,
      binding: { chatId: 42 },
      rpcTarget: { chat_id: 42 },
    },
    {
      target: "+15550004567",
      replyToId: "sms-reply-guid",
      service: "sms",
      binding: { chatGuid: "SMS;-;+15550004567", chatIdentifier: "+15550004567" },
      rpcTarget: { to: "+15550004567", service: "sms" },
    },
  ] as const)(
    "authorizes a delegated reply with a current binding for $target",
    async ({ target, replyToId, service, binding, rpcTarget }) => {
      const client = createClient({ guid: "p:0/imsg-bound" });
      await rememberIMessageReplyCache({
        accountId: "default",
        messageId: replyToId,
        ...binding,
        timestamp: Date.now(),
      });
      await expect(
        sendMessageIMessage(target, "hello", {
          config: {
            channels: { imessage: { remoteHost: "qa@example.invalid", accounts: { default: {} } } },
          },
          client,
          service,
          conversationReadOrigin: "delegated",
          replyToId,
        }),
      ).resolves.toMatchObject({ messageId: "p:0/imsg-bound" });
      expectRequest(getClientMocks(client).request, "send", { ...rpcTarget, reply_to: replyToId });
    },
  );

  it("rejects a delegated reply when an auto handle has no concrete service", async () => {
    const client = createClient({ guid: "should-not-send" });
    await rememberIMessageReplyCache({
      accountId: "default",
      messageId: "ambiguous-service-guid",
      chatGuid: "SMS;-;+15550004567",
      chatIdentifier: "+15550004567",
      timestamp: Date.now(),
    });

    await expect(
      sendMessageIMessage("+15550004567", "hello", {
        config: {
          channels: { imessage: { remoteHost: "qa@example.invalid", accounts: { default: {} } } },
        },
        client,
        conversationReadOrigin: "delegated",
        replyToId: "ambiguous-service-guid",
      }),
    ).rejects.toThrow("require a current same-account conversation binding");

    expect(getClientMocks(client).request).not.toHaveBeenCalled();
  });

  it("resolves service-qualified remote media through the canonical send RPC", async () => {
    const client = createClient({
      guid: "p:0/remote-resolved-media",
      chat_guid: "any;-;+15550004567",
      service: "iMessage",
    });
    const createRpc = vi.spyOn(clientRuntime, "createIMessageRpcClient").mockResolvedValue(client);
    const withRemoteFile = vi
      .spyOn(remoteFile, "withIMessageRemoteFile")
      .mockImplementation(
        async (params) => await params.use("/tmp/openclaw-imessage-safe/photo.png"),
      );
    mockAttachment({ path: "/gateway/photo.png" });

    const result = await sendMessageIMessage("imessage:+15550004567", "", {
      config: {
        channels: {
          imessage: {
            cliPath: "/gateway/default-imsg",
            dbPath: "/Users/default/Library/Messages/chat.db",
            remoteHost: "default@messages-a",
            accounts: {
              work: {
                cliPath: "/gateway/work-imsg",
                dbPath: "~/Library/Messages/chat.db",
                remoteHost: "work@messages-b",
              },
            },
          },
        },
      },
      accountId: "work",
      mediaUrl: "/gateway/photo.png",
    });

    expect(createRpc).toHaveBeenCalledWith({
      cliPath: "/gateway/work-imsg",
      dbPath: "~/Library/Messages/chat.db",
      remoteHost: "work@messages-b",
    });
    expect(withRemoteFile).toHaveBeenCalledWith(
      expect.objectContaining({
        remoteHost: "work@messages-b",
        localPath: "/gateway/photo.png",
      }),
    );
    expectRequest(getClientMocks(client).request, "send", {
      to: "+15550004567",
      file: "/tmp/openclaw-imessage-safe/photo.png",
      service: "imessage",
    });
    expect(result).toMatchObject({
      messageId: "p:0/remote-resolved-media",
      chatGuid: "any;-;+15550004567",
      service: "imessage",
    });
  });

  it("fails closed before staging media from an ambiguous proxy wrapper", async () => {
    const sshOperands = "-o ProxyCommand=jump@proxy bot@messages-mac";
    const cliPath = createOutboundMediaFile(
      "imsg-jump-wrapper",
      Buffer.from(`#!/bin/sh\nexec ssh ${sshOperands} imsg "$@"\n`),
    );
    const runCliJson = mockCliSend()
      .mockResolvedValueOnce({ guid: "iMessage;+;chat0000" })
      .mockResolvedValueOnce({ guid: "p:0/local-media" });
    const withRemoteFile = vi
      .spyOn(remoteFile, "withIMessageRemoteFile")
      .mockRejectedValue(new Error("unexpected remote staging"));
    mockAttachment({ path: "/gateway/photo.png" });

    await expect(
      sendMessageIMessage("chat_id:42", "", {
        config: { channels: { imessage: { cliPath } } },
        mediaUrl: "/gateway/photo.png",
      }),
    ).rejects.toThrow("configure channels.imessage.remoteHost explicitly");

    expect(runCliJson).not.toHaveBeenCalled();
    expect(withRemoteFile).not.toHaveBeenCalled();
  });

  it("floors a configured probe timeout so one delayed imsg fallback can resolve", async () => {
    vi.useFakeTimers();
    const delayedFallbackMs = 158_000;
    const requestStarted = createDeferred<void>();
    const client = {
      request: vi.fn(
        (_method: string, _params: Record<string, unknown>, opts?: { timeoutMs?: number }) => {
          requestStarted.resolve();
          return new Promise<Record<string, unknown>>((resolve, reject) => {
            const timeout = setTimeout(
              () => reject(new Error("imsg rpc timeout (send)")),
              opts?.timeoutMs,
            );
            setTimeout(() => {
              clearTimeout(timeout);
              resolve({ guid: "p:0/imsg-delayed-fallback" });
            }, delayedFallbackMs);
          });
        },
      ),
      stop: vi.fn(async () => {}),
    } as unknown as IMessageRpcClient;

    const send = sendMessageIMessage("chat_id:42", "hello", {
      config: {
        channels: {
          imessage: {
            ...IMESSAGE_TEST_CFG.channels.imessage,
            probeTimeoutMs: 10_000,
          },
        },
      },
      client,
    });
    await requestStarted.promise;
    await vi.advanceTimersByTimeAsync(delayedFallbackMs);

    await expect(send).resolves.toMatchObject({ messageId: "p:0/imsg-delayed-fallback" });
    expect(getClientMocks(client).request).toHaveBeenCalledTimes(1);
    expect(getClientMocks(client).request).toHaveBeenCalledWith(
      "send",
      expect.any(Object),
      expect.objectContaining({ timeoutMs: 180_000 }),
    );
  });

  it("sends native voice as a threaded reply", async () => {
    const replyToId = "p:0/reply-guid";
    const client = createClient({ message_id: 12345 });
    const runCliJson = mockCliSend().mockResolvedValueOnce({ messageGuid: "p:0/voice-guid" });
    mockAttachment({ path: "/tmp/voice.caf", contentType: "audio/x-caf" });

    const result = await sendMessageIMessage("chat_guid:chat-1", "", {
      config: IMESSAGE_TEST_CFG,
      client,
      mediaUrl: "/tmp/voice.caf",
      audioAsVoice: true,
      conversationReadOrigin: "direct-operator",
      replyToId,
    });

    expect(result.messageId).toBe("p:0/voice-guid");
    expect(result.guid).toBe("p:0/voice-guid");
    expect(result.receipt.replyToId).toBe(replyToId);
    expect(runCliJson.mock.calls).toEqual([
      [attachmentArgs("chat-1", "/tmp/voice.caf", "auto", ["--audio", "--reply-to", replyToId])],
    ]);
    expect(result.receipt.platformMessageIds).toEqual(["p:0/voice-guid"]);
    expect(result.receipt.parts.map((part) => part.kind)).toEqual(["voice"]);
    expect(client["request"]).not.toHaveBeenCalled();
  });

  it("rejects threaded AppleScript voice notes without downgrading native audio", async () => {
    const replyToId = "p:0/reply-guid";
    const client = createClient({ guid: "should-not-send" });
    const runCliJson = mockCliSend();
    mockAttachment({ path: "/tmp/voice.caf", contentType: "audio/x-caf" });

    await expect(
      sendMessageIMessage("chat_guid:chat-1", "", {
        config: { channels: { imessage: { sendTransport: "applescript" } } },
        client,
        conversationReadOrigin: "direct-operator",
        mediaUrl: "/tmp/voice.caf",
        audioAsVoice: true,
        replyToId,
      }),
    ).rejects.toThrow("voice messages require bridge transport");

    expect(runCliJson).not.toHaveBeenCalled();
    expect(getClientMocks(client).request).not.toHaveBeenCalled();
  });

  it.each([
    {
      target: "chat_guid:chat-1",
      error: "unknown command send-attachment",
      command: attachmentArgs("chat-1", "/tmp/image.png"),
      rpcTarget: { chat_guid: "chat-1" },
    },
    {
      target: "chat_id:42",
      error: "private API bridge unavailable",
      command: ["group", "--chat-id", "42"],
      rpcTarget: { chat_id: 42 },
    },
  ])(
    "falls back to RPC when native attachment preparation fails for $target",
    async ({ target, error, command, rpcTarget }) => {
      const client = createClient({ message_id: 12345 });
      const runCliJson = mockCliSend().mockRejectedValueOnce(new Error(error));
      mockAttachment({ path: "/tmp/image.png", contentType: "image/png" });

      const result = await sendMessageIMessage(target, "", {
        config: IMESSAGE_TEST_CFG,
        client,
        mediaUrl: "/tmp/image.png",
      });

      expect(result.messageId).toBe("12345");
      expect(runCliJson.mock.calls).toEqual([[command]]);
      expectRequest(client["request"], "send", {
        ...rpcTarget,
        file: "/tmp/image.png",
        text: "",
      });
    },
  );

  it("preserves explicit bridge delivery for a new service-qualified media chat", async () => {
    const client = createClient({ guid: "should-not-send" });
    const runCliJson = mockCliSend().mockResolvedValueOnce({
      messageGuid: "p:0/bridge-media-guid",
    });
    mockAttachment({ path: "/tmp/image.png", contentType: "image/png" });

    await sendMessageIMessage("imessage:+15550004567", "", {
      config: { channels: { imessage: { sendTransport: "bridge" } } },
      client,
      mediaUrl: "/tmp/image.png",
    });

    expect(runCliJson).toHaveBeenCalledWith(
      attachmentArgs("iMessage;-;+15550004567", "/tmp/image.png", "dylib"),
    );
    expect(getClientMocks(client).request).not.toHaveBeenCalled();
  });

  it("preserves staged filenames across native RPC sends and their unthreaded retry", async () => {
    const filename = "threaded-review.pdf";
    const attachmentBytes = Buffer.from("actual native rpc provider bytes");
    const sourcePath = createOutboundMediaFile(filename, attachmentBytes);
    const deliveredPaths: string[] = [];
    const client = {
      request: vi.fn(async (_method: string, params: Record<string, unknown>) => {
        const attachmentPath = params.file as string;
        deliveredPaths.push(attachmentPath);
        expect(fs.readFileSync(attachmentPath)).toEqual(attachmentBytes);
        if (params.reply_to) {
          throw new Error(
            "reply_to requires bridge transport; AppleScript fallback cannot send threaded replies",
          );
        }
        return { guid: "p:0/provider-accepted-rpc" };
      }),
      stop: vi.fn(async () => {}),
    } as unknown as IMessageRpcClient;

    const result = await sendMessageIMessage("chat_id:42", "caption", {
      config: IMESSAGE_TEST_CFG,
      client,
      conversationReadOrigin: "direct-operator",
      replyToId: "p:0/thread-root",
      mediaUrl: sourcePath,
      mediaLocalRoots: [openClawState.root],
    });

    expect(result.messageId).toBe("p:0/provider-accepted-rpc");
    expect(result.receipt.replyToId).toBeUndefined();
    expect(deliveredPaths.map((attachmentPath) => path.basename(attachmentPath))).toEqual([
      filename,
      filename,
    ]);
    expect(deliveredPaths.every((attachmentPath) => !fs.existsSync(attachmentPath))).toBe(true);
    expect(fs.readdirSync(openClawState.statePath("media", "outbound"))).toHaveLength(1);
  });

  it("does not persist caption text when the caption follow-up send fails", async () => {
    const captionError = new Error("caption failed");
    const client = createRejectingClient(captionError);
    mockCliSend().mockResolvedValueOnce({ messageGuid: "p:0/dm-media-guid" });
    mockAttachment({ path: "/tmp/image.png", contentType: "image/png" });
    const onDeliveryResult = vi.fn();

    const observedError = await sendMessageIMessage("+15550004567", "caption", {
      config: IMESSAGE_TEST_CFG,
      client,
      mediaUrl: "/tmp/image.png",
      onDeliveryResult,
    }).catch((error: unknown) => error);

    expect(isChannelPartialDeliveryError(observedError)).toBe(true);
    expect(observedError).toMatchObject({
      code: "CHANNEL_PARTIAL_DELIVERY",
      cause: captionError,
      sentBeforeError: true,
      visibleReplySent: true,
      deliveryResult: { content: "", messageIds: ["p:0/dm-media-guid"], visibleReplySent: true },
    });
    expect(onDeliveryResult).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        content: "",
        messageId: "p:0/dm-media-guid",
        messageIds: ["p:0/dm-media-guid"],
        visibleReplySent: true,
      }),
    );
    const scope = "default:imessage:+15550004567";
    expect(await hasPersistedIMessageEcho({ scope, text: "caption" })).toBe(false);
    expect(
      await hasPersistedIMessageEcho({ scope, media: { contentType: "image/png", kind: "image" } }),
    ).toBe(true);
    expect(await hasPersistedIMessageEcho({ scope, messageId: "p:0/dm-media-guid" })).toBe(true);
  });

  it("stops before a caption when accepted attachment custody cannot be recorded", async () => {
    const custodyError = new Error("accepted attachment custody failed");
    const client = createClient({ guid: "p:0/caption-guid" });
    mockCliSend().mockResolvedValueOnce({ messageId: "p:0/dm-media-guid" });
    mockAttachment({ path: "/tmp/image.png", contentType: "image/png" });
    const onDeliveryResult = vi.fn(async () => {
      throw custodyError;
    });

    await expect(
      sendMessageIMessage("+15550004567", "caption", {
        config: IMESSAGE_TEST_CFG,
        client,
        mediaUrl: "/tmp/image.png",
        onDeliveryResult,
      }),
    ).rejects.toBe(custodyError);

    expect(isChannelPartialDeliveryError(custodyError)).toBe(false);
    expect(getClientMocks(client).request).not.toHaveBeenCalled();
    expect(onDeliveryResult).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        content: "",
        messageId: "p:0/dm-media-guid",
        messageIds: ["p:0/dm-media-guid"],
        visibleReplySent: true,
      }),
    );
  });

  it.each([
    {
      target: "+15550004567",
      attachment: { success: true },
      mediaId: undefined,
      ownsClient: false,
      rpcTarget: { to: "+15550004567" },
    },
    {
      target: "+15550004567",
      attachment: { messageId: "p:0/dm-media-guid" },
      mediaId: "p:0/dm-media-guid",
      ownsClient: true,
      rpcTarget: { to: "+15550004567" },
    },
  ])(
    "combines caption receipts for $target, media ID $mediaId, owned client $ownsClient",
    async ({ target, attachment, mediaId, ownsClient, rpcTarget }) => {
      const client = createClient({ guid: "p:0/caption-guid" });
      vi.spyOn(clientRuntime, "createIMessageRpcClient").mockResolvedValue(client);
      mockCliSend().mockResolvedValueOnce(attachment);
      mockAttachment({ path: "/tmp/image.png", contentType: "image/png" });
      const result = await sendMessageIMessage(target, "caption", {
        config: IMESSAGE_TEST_CFG,
        ...(ownsClient ? {} : { client }),
        mediaUrl: "/tmp/image.png",
      });
      expectRequest(getClientMocks(client).request, "send", { ...rpcTarget, text: "caption" });
      expect(getClientMocks(client).stop).toHaveBeenCalledTimes(ownsClient ? 1 : 0);
      expect(result.messageId).toBe(mediaId ?? "p:0/caption-guid");
      expect(result.sentText).toBe("caption");
      expect(result.receipt.platformMessageIds).toEqual(
        mediaId ? [mediaId, "p:0/caption-guid"] : ["p:0/caption-guid"],
      );
      expect(result.receipt.parts.map((part) => part.kind)).toEqual(
        mediaId ? ["media", "text"] : ["text"],
      );
    },
  );

  it("keeps the pending echo marker alive for slow default-timeout sends", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-04T00:00:00Z"));
    const requestStarted = createDeferred<void>();
    const response = createDeferred<Record<string, unknown>>();
    const client = {
      request: vi.fn(() => {
        requestStarted.resolve();
        return response.promise;
      }),
      stop: vi.fn(async () => {}),
    } as unknown as IMessageRpcClient;

    const send = sendMessageIMessage("+15551234567", "slow hello", {
      config: IMESSAGE_TEST_CFG,
      client,
    });
    await requestStarted.promise;

    vi.setSystemTime(new Date("2026-06-04T00:01:01Z"));
    expect(
      await hasPersistedIMessageEcho({
        scope: "default:imessage:+15551234567",
        text: "slow hello",
        includePendingText: true,
      }),
    ).toBe(true);

    response.resolve({ guid: "p:0/imsg-slow" });
    await expect(send).resolves.toMatchObject({ messageId: "p:0/imsg-slow" });
  });

  it("awaits approval binding completion before returning a send receipt", async () => {
    const reactions = await import("./approval-reactions.js");
    const persisted =
      createDeferred<
        Awaited<ReturnType<ApprovalReactionsModule["registerIMessageApprovalReactionTarget"]>>
      >();
    const started = createDeferred<void>();
    vi.spyOn(reactions, "registerIMessageApprovalReactionTarget").mockImplementation(() => {
      started.resolve();
      return persisted.promise;
    });
    let completed = false;
    const send = sendMessageIMessage("chat_id:42", createApprovalText(), {
      config: IMESSAGE_TEST_CFG,
      client: createClient({ guid: "p:0/durable-approval" }),
      dbPath: openClawState.path("synthetic-chat.db"),
      approvalPrompt: createApprovalPrompt(),
    }).then((receipt) => {
      completed = true;
      return receipt;
    });
    try {
      await started.promise;
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(completed).toBe(false);
      persisted.resolve({
        approvalId: "approval-123",
        approvalKind: "exec",
        allowedDecisions: ["allow-once", "deny"],
      });
      await expect(send).resolves.toMatchObject({ guid: "p:0/durable-approval" });
    } finally {
      persisted.resolve(null);
      await Promise.allSettled([send]);
    }
  });

  it("uses the default local chat.db for absolute CLI path timeout recovery", async () => {
    const cliPath = createOutboundMediaFile("imsg", Buffer.from("#!/bin/sh\nexit 0\n"));
    vi.stubEnv("HOME", openClawState.root);
    const dbPath = openClawState.path("Library", "Messages", "chat.db");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.writeFileSync(dbPath, "");
    const client = createRejectingClient(new Error("imsg rpc timeout (send)"));
    const runCliJson = mockCliSend();
    const readGuid = vi.fn(async () => "p:0/default-db-guid");
    const openReader = vi
      .spyOn(chatDb, "withIMessageReceiptGuidReader")
      .mockImplementation(async (_dbPath, use) => await use(readGuid));
    const approvalText = createApprovalText("approval-default");

    const result = await sendMessageIMessage("chat_id:42", approvalText, {
      config: IMESSAGE_TEST_CFG,
      approvalPrompt: createApprovalPrompt("approval-default"),
      client,
      cliPath,
    });

    expect(result.messageId).toBe("p:0/default-db-guid");
    expect(runCliJson).not.toHaveBeenCalled();
    expect(openReader).toHaveBeenCalledWith(dbPath, expect.any(Function));
  });

  it("does not recover SSH wrapper receipts from local chat.db", async () => {
    vi.stubEnv("HOME", openClawState.root);
    const cliPath = createOutboundMediaFile(
      "imsg",
      Buffer.from('#!/bin/sh\nexec ssh -T gateway-host imsg "$@"\n'),
    );
    await resolveIMessageRemoteHost({ cliPath });
    const { client, requestStarted } = createTimedOutSendClient();
    const runCliJson = mockCliSend();
    const openReader = vi
      .spyOn(chatDb, "withIMessageReceiptGuidReader")
      .mockRejectedValue(new Error("unexpected Messages database access"));
    const rejection = expect(
      sendMessageIMessage("chat_id:42", createApprovalText("approval-remote"), {
        config: IMESSAGE_TEST_CFG,
        approvalPrompt: createApprovalPrompt("approval-remote"),
        client,
        cliPath,
      }),
    ).rejects.toThrow("imsg rpc timeout (send)");
    await requestStarted;
    await rejection;
    expect(runCliJson).not.toHaveBeenCalled();
    expect(openReader).not.toHaveBeenCalled();
  });

  it("recovers approval tapback GUIDs when RPC returns an unknown placeholder", async () => {
    const client = createClient({ messageId: "unknown", status: "sent" });
    const dbPath = createOutboundMediaFile("synthetic-chat.db", Buffer.alloc(0));
    const readGuid = vi.fn(async () => "p:0/recovered-guid");
    const openReader = vi
      .spyOn(chatDb, "withIMessageReceiptGuidReader")
      .mockImplementation(async (_dbPath, use) => await use(readGuid));
    const approvalText = createApprovalText();

    const result = await sendMessageIMessage("chat_id:42", approvalText, {
      config: IMESSAGE_TEST_CFG,
      approvalPrompt: createApprovalPrompt(),
      client,
      dbPath,
    });

    expect(result.messageId).toBe("unknown");
    expect(result.guid).toBe("p:0/recovered-guid");
    await expect(
      resolveIMessageApprovalReactionTargetWithPersistence({
        accountId: "default",
        conversation: { chatId: 42 },
        messageId: "p:0/recovered-guid",
        reactionKey: "👍",
      }),
    ).resolves.toEqual({
      approvalId: "approval-123",
      approvalKind: "exec",
      decision: "allow-once",
    });
    expect(openReader).toHaveBeenCalledWith(dbPath, expect.any(Function));
    expect(readGuid).toHaveBeenCalledWith({
      type: "latestSentGuid",
      input: {
        target: expect.objectContaining({ kind: "chat_id", chatId: 42 }),
        text: expect.stringContaining("ID: approval-123"),
        sentAfterMs: expect.any(Number),
      },
    });
  });

  it("does not poll for approval prompt GUIDs when chat.db is unavailable", async () => {
    vi.useFakeTimers();
    const client = createClient({ status: "sent" });
    const approvalText = createApprovalText();

    const result = await sendMessageIMessage("chat_id:42", approvalText, {
      config: IMESSAGE_TEST_CFG,
      approvalPrompt: createApprovalPrompt(),
      client,
    });

    // Fake timers are intentionally not advanced: entering the polling loop
    // would leave this awaited send pending and fail the test by timeout.
    expect(result.messageId).toBe("ok");
    expect(result.guid).toBeUndefined();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
