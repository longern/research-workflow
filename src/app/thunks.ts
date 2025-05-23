import {
  Response,
  ResponseFunctionToolCall,
  ResponseFunctionWebSearch,
  ResponseInputItem,
  ResponseInputText,
  ResponseOutputItem,
  ResponseReasoningItem,
  ResponseStreamEvent,
  Tool,
} from "openai/resources/responses/responses.mjs";
import OpenAI from "openai";

import {
  add as addMessage,
  ChatMessage,
  addContentPart,
  addReasoningSummaryPart,
  contentPartDelta,
  reasoningSummaryTextDelta,
  update as updateMessage,
  functionCallArgumentsDelta,
} from "./messages";
import { createAppAsyncThunk, AppDispatch } from "./store";

interface FunctionCallOutputCompletedEvent {
  item: ResponseInputItem.FunctionCallOutput;
  output_index: number;
  type: "response.functioin_call_output.completed";
}

interface FunctionCallOutputIncompleteEvent {
  item: ResponseInputItem.FunctionCallOutput;
  output_index: number;
  type: "response.functioin_call_output.incomplete";
}

export function messageDispatchWrapper(dispatch: AppDispatch) {
  const messageDispatch = (
    event:
      | ResponseStreamEvent
      | FunctionCallOutputCompletedEvent
      | FunctionCallOutputIncompleteEvent
  ) => {
    switch (event.type) {
      case "response.output_item.added":
        dispatch(addMessage(event.item));
        break;

      case "response.output_item.done": {
        if (!("status" in event.item) && event.item.type !== "reasoning") break;
        const eventStatus = event.item.status as
          | "completed"
          | "in_progress"
          | "incomplete"
          | undefined;
        const isReasoningCompleted =
          event.item.type === "reasoning" && eventStatus === undefined;
        const status = isReasoningCompleted ? "completed" : eventStatus;
        dispatch(updateMessage({ id: event.item.id!, patch: { status } }));
        break;
      }

      case "response.content_part.added":
        dispatch(addContentPart(event));
        break;

      case "response.output_text.delta":
        dispatch(contentPartDelta(event));
        break;

      case "response.reasoning_summary_part.added":
        dispatch(addReasoningSummaryPart(event));
        break;

      case "response.reasoning_summary_text.delta":
        dispatch(reasoningSummaryTextDelta(event));
        break;

      case "response.function_call_arguments.delta":
        dispatch(functionCallArgumentsDelta(event));
        break;

      case "response.functioin_call_output.completed":
        dispatch(
          updateMessage({
            id: event.item.id!,
            patch: { status: "completed", output: event.item.output },
          })
        );
        break;

      case "response.functioin_call_output.incomplete":
        dispatch(
          updateMessage({
            id: event.item.id!,
            patch: { status: "incomplete", output: event.item.output },
          })
        );
        break;
    }
  };

  return messageDispatch;
}

export type CreateResponseParams = { model?: string; tools?: Tool[] };

async function streamRequestAssistant(
  messages: ResponseInputItem[],
  options?: {
    apiKey?: string;
    baseURL?: string;
    signal?: AbortSignal;
    onStreamEvent: (event: ResponseStreamEvent) => void;
  } & CreateResponseParams
) {
  const client = new OpenAI({
    apiKey: options?.apiKey,
    baseURL:
      options?.baseURL || new URL("/api/v1", window.location.href).toString(),
    dangerouslyAllowBrowser: true,
  });
  const model =
    options?.model ?? messages.some((m) => m.type === "reasoning")
      ? "o4-mini"
      : "gpt-4.1-nano";
  const response = await client.responses.create(
    {
      model: model,
      input: messages,
      stream: true,
      reasoning: model.startsWith("o") ? { summary: "detailed" } : undefined,
      tools: options?.tools,
    },
    { signal: options?.signal }
  );

  let result: Response;
  for await (const chunk of response) {
    options?.onStreamEvent?.(chunk);
    if (chunk.type === "response.completed") result = chunk.response;
  }

  return result!;
}

export interface SearchResults {
  items: Array<{
    title: string;
    htmlTitle: string;
    link: string;
    formattedUrl: string;
    htmlFormattedUrl: string;
    snippet: string;
  }>;
}

function formatSearchResults(items: SearchResults) {
  // Markdown format
  return items.items
    .map(
      (item) =>
        `- [${item.title}](${item.link})\n\n  ${item.snippet.replace(
          /<[^>]+>/g,
          ""
        )}`
    )
    .join("\n");
}

async function callFunction({
  name,
  args,
  signal,
}: {
  name: string;
  args: string;
  signal: AbortSignal;
}) {
  switch (name) {
    case "run_python":
      const pythonCode = JSON.parse(args).code;
      const res = await fetch("https://emkc.org/api/v2/piston/execute", {
        method: "POST",
        body: JSON.stringify({
          language: "python3",
          version: "3.10",
          files: [{ name: "main.py", content: pythonCode }],
        }),
        headers: { "Content-Type": "application/json" },
        signal,
      });
      if (!res.ok) {
        const errorText = await res.text();
        throw new Error(errorText);
      }
      return res.text();

    case "google_search":
      const query = JSON.parse(args).query;
      const searchRes = await fetch(
        `/api/search?${new URLSearchParams({ q: query })}`,
        { signal }
      );
      if (!searchRes.ok) {
        const errorText = await searchRes.text();
        throw new Error(errorText);
      }
      const searchBody: SearchResults = await searchRes.json();
      return formatSearchResults(searchBody);

    default:
      throw new Error(`Unknown function name: ${name}`);
  }
}

async function handleFunctionCall({
  message,
  signal,
}: {
  message: ResponseFunctionToolCall;
  signal: AbortSignal;
}) {
  try {
    const output = await callFunction({
      name: message.name,
      args: message.arguments,
      signal,
    });
    const toolCallOutputMessage: ResponseInputItem.FunctionCallOutput = {
      type: "function_call_output",
      call_id: message.call_id,
      output: output,
      status: "completed",
    };
    return toolCallOutputMessage;
  } catch (error) {
    const toolCallErrorMessage: ResponseInputItem.FunctionCallOutput = {
      type: "function_call_output",
      call_id: message.call_id,
      output: (error as Error).message,
      status: "incomplete",
    };
    return toolCallErrorMessage;
  }
}

export const requestFunctionCall = createAppAsyncThunk(
  "app/requestFunctionCall",
  async (message: ResponseFunctionToolCall, thunkAPI) => {
    const { dispatch, signal } = thunkAPI;
    const outputMessage = await handleFunctionCall({
      message,
      signal,
    });
    dispatch(addMessage(outputMessage));
  }
);

function normMessage(message: ChatMessage): ResponseInputItem {
  if (!("created_at" in message)) return message;
  if (
    (message.type === "message" &&
      (message.role === "user" ||
        message.role === "developer" ||
        message.role === "system")) ||
    message.type === "function_call_output"
  ) {
    const { id, created_at, ...rest } = message;
    return rest as ResponseInputItem.Message;
  } else if (message.type === "reasoning") {
    const { created_at, status, ...rest } = message;
    return rest as ResponseReasoningItem;
  }
  const { created_at, ...rest } = message;
  return rest as ResponseInputItem;
}

export const requestAssistant = createAppAsyncThunk(
  "app/requestAssistant",
  async (
    {
      messages,
      options,
    }: {
      messages: ChatMessage[];
      options?: CreateResponseParams;
    },
    thunkAPI
  ) => {
    const { dispatch, getState, signal } = thunkAPI;
    const provider = getState().provider;
    const messageDispatch = messageDispatchWrapper(dispatch);
    try {
      const currentMessages = messages.map(normMessage);

      const MAX_TOOL_CALLS = 5;
      for (let i = 0; i < MAX_TOOL_CALLS; i++) {
        const response = await streamRequestAssistant(currentMessages, {
          apiKey: provider.apiKey,
          baseURL: provider.baseURL,
          signal,
          onStreamEvent: messageDispatch,
          ...options,
        });

        currentMessages.push(...response.output);
        const lastMessage = currentMessages[currentMessages.length - 1];
        if (lastMessage.type !== "function_call") break;
        const functionCallMessage = await handleFunctionCall({
          message: lastMessage,
          signal,
        });
        currentMessages.push(functionCallMessage);
        dispatch(addMessage(functionCallMessage));
      }
    } catch (error) {
      dispatch(
        addMessage({
          type: "message",
          role: "assistant",
          content: [{ type: "refusal", refusal: (error as Error).message }],
          status: "incomplete",
        } as ResponseOutputItem)
      );
    }
  }
);

export const requestSearch = createAppAsyncThunk(
  "app/requestSearch",
  async (messages: ChatMessage[], thunkAPI) => {
    const { dispatch, signal } = thunkAPI;
    const lastMessage = messages[
      messages.length - 1
    ] as ResponseInputItem.Message;
    const part = lastMessage.content[0] as ResponseInputText;
    const query = part.text;

    const callId = crypto.randomUUID();
    const toolCallMessage: ResponseFunctionToolCall = {
      id: crypto.randomUUID(),
      type: "function_call",
      call_id: callId,
      name: "search",
      arguments: JSON.stringify({ query }),
      status: "completed",
    };
    dispatch(addMessage(toolCallMessage));

    const response = await fetch(
      `/api/search?${new URLSearchParams({ q: query })}`,
      { signal }
    );
    const body = await response.json();
    const toolCallOutputMessage: ResponseInputItem.FunctionCallOutput = {
      id: crypto.randomUUID(),
      type: "function_call_output",
      call_id: callId,
      output: JSON.stringify(body.items),
      status: "completed",
    };
    dispatch(addMessage(toolCallOutputMessage));
  }
);

export const requestSearchImage = createAppAsyncThunk(
  "app/requestSearchImage",
  async (messages: ChatMessage[], thunkAPI) => {
    const { dispatch } = thunkAPI;

    const lastMessage = messages[
      messages.length - 1
    ] as ResponseInputItem.Message;
    const part = lastMessage.content[0] as ResponseInputText;
    const query = part.text;

    const callId = crypto.randomUUID();
    const toolCallMessage: ResponseFunctionToolCall = {
      id: crypto.randomUUID(),
      type: "function_call",
      call_id: callId,
      name: "search_image",
      arguments: JSON.stringify({ query }),
      status: "completed",
    };
    dispatch(addMessage(toolCallMessage));

    const response = await fetch(
      `/api/search?${new URLSearchParams({ q: query, searchType: "image" })}`
    );
    const body = await response.json();
    const toolCallOutputMessage: ResponseInputItem.FunctionCallOutput = {
      id: crypto.randomUUID(),
      type: "function_call_output",
      call_id: callId,
      output: JSON.stringify(body.items),
      status: "completed",
    };
    dispatch(addMessage(toolCallOutputMessage));
  }
);

export const requestGenerateImage = createAppAsyncThunk(
  "app/requestGenerateImage",
  async (messages: ChatMessage[], thunkAPI) => {
    const { dispatch, getState, signal } = thunkAPI;
    const provider = getState().provider;

    const client = new OpenAI({
      apiKey: provider.apiKey,
      baseURL:
        provider?.baseURL ||
        new URL("/api/v1", window.location.href).toString(),
      dangerouslyAllowBrowser: true,
    });
    const response = await client.responses.create(
      {
        model: "gpt-4.1-nano",
        input: messages.map(normMessage),
        tools: [
          {
            type: "image_generation",
            moderation: "low",
            quality: provider.imageQuality,
          },
        ],
      },
      { signal }
    );

    for await (const message of response.output) {
      dispatch(addMessage(message));
    }
  }
);

export const requestCreateResearch = createAppAsyncThunk(
  "app/requestCreateResearch",
  async (task: string, thunkAPI) => {
    const { dispatch, signal } = thunkAPI;
    const response = await fetch("/api/tasks", {
      method: "PUT",
      body: JSON.stringify({ instructions: task }),
      headers: { "Content-Type": "application/json" },
      signal,
    });
    const { id } = await response.json();

    dispatch(
      addMessage({
        type: "web_search_call",
        id,
        status: "in_progress",
      } as ResponseFunctionWebSearch)
    );
  }
);
