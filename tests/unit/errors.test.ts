import { describe, expect, it } from "bun:test";
import { ClientError, Status } from "nice-grpc-common";
import {
  fromCloudResponse,
  fromGrpcError,
  parsePermissionKind,
} from "../../src/errors/error-handler";
import {
  AuthenticationError,
  ConnectionError,
  NotFoundError,
  PermissionError,
  RateLimitError,
  SlackError,
  ValidationError,
} from "../../src/errors/slack-error";

function clientErrorWithMetadata(
  code: Status,
  message: string,
  metadata: Record<string, string>
): ClientError {
  const err = new ClientError("/svc/method", code, message);
  Object.defineProperty(err, "metadata", {
    value: {
      get(key: string): unknown[] {
        const v = metadata[key];
        return v === undefined ? [] : [v];
      },
    },
    writable: true,
    configurable: true,
  });
  return err;
}

describe("fromGrpcError", () => {
  it("maps UNAUTHENTICATED → AuthenticationError", () => {
    const err = fromGrpcError(
      new ClientError("/x", Status.UNAUTHENTICATED, "nope")
    );
    expect(err).toBeInstanceOf(AuthenticationError);
    expect(err.context.source).toBe("grpc");
  });

  it("maps PERMISSION_DENIED → PermissionError with parsed permission kind", () => {
    const err = fromGrpcError(
      new ClientError(
        "/x",
        Status.PERMISSION_DENIED,
        "feature_not_enabled:reactions"
      )
    );
    expect(err).toBeInstanceOf(PermissionError);
    expect((err as PermissionError).permission).toEqual({
      kind: "feature_not_enabled",
      feature: "reactions",
    });
  });

  it("maps platform_disabled message → kind platform_disabled", () => {
    const err = fromGrpcError(
      new ClientError("/x", Status.PERMISSION_DENIED, "platform_disabled")
    );
    expect((err as PermissionError).permission.kind).toBe("platform_disabled");
  });

  it("maps NOT_FOUND → NotFoundError", () => {
    const err = fromGrpcError(new ClientError("/x", Status.NOT_FOUND, "?"));
    expect(err).toBeInstanceOf(NotFoundError);
  });

  it("maps RESOURCE_EXHAUSTED → RateLimitError with retryAfterMs", () => {
    const err = fromGrpcError(
      clientErrorWithMetadata(Status.RESOURCE_EXHAUSTED, "rate", {
        "retry-after": "5",
      })
    );
    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as RateLimitError).retryAfterMs).toBe(5000);
  });

  it("maps INVALID_ARGUMENT → ValidationError", () => {
    const err = fromGrpcError(
      new ClientError("/x", Status.INVALID_ARGUMENT, "bad")
    );
    expect(err).toBeInstanceOf(ValidationError);
  });

  it("maps UNAVAILABLE → ConnectionError", () => {
    const err = fromGrpcError(
      new ClientError("/x", Status.UNAVAILABLE, "down")
    );
    expect(err).toBeInstanceOf(ConnectionError);
  });

  it("maps other statuses → base SlackError", () => {
    const err = fromGrpcError(new ClientError("/x", Status.INTERNAL, "oops"));
    expect(err).toBeInstanceOf(SlackError);
    expect(err).not.toBeInstanceOf(ConnectionError);
  });
});

describe("parsePermissionKind", () => {
  it("parses feature_not_enabled:<feature>", () => {
    expect(parsePermissionKind("feature_not_enabled:files")).toEqual({
      kind: "feature_not_enabled",
      feature: "files",
    });
  });
  it("parses team_id not owned", () => {
    expect(parsePermissionKind("team_id not owned by sub")).toEqual({
      kind: "team_not_owned",
    });
  });
  it("falls back to other", () => {
    expect(parsePermissionKind("something else")).toEqual({
      kind: "other",
      detail: "something else",
    });
  });
});

describe("fromCloudResponse", () => {
  function makeResponse(
    status: number,
    headers?: Record<string, string>
  ): Response {
    return new Response(null, {
      status,
      headers: headers ?? {},
    });
  }

  it("maps 401 → AuthenticationError", () => {
    const err = fromCloudResponse(makeResponse(401));
    expect(err).toBeInstanceOf(AuthenticationError);
    expect(err.context.source).toBe("spectrum-cloud");
  });

  it("maps 403 + platform_disabled → PermissionError(platform_disabled)", () => {
    const err = fromCloudResponse(makeResponse(403), {
      message: "platform_disabled",
    });
    expect(err).toBeInstanceOf(PermissionError);
    expect((err as PermissionError).permission.kind).toBe("platform_disabled");
  });

  it("maps 404 → NotFoundError", () => {
    const err = fromCloudResponse(makeResponse(404));
    expect(err).toBeInstanceOf(NotFoundError);
  });

  it("maps 422 / VALIDATION_ERROR → ValidationError", () => {
    const err = fromCloudResponse(makeResponse(422));
    expect(err).toBeInstanceOf(ValidationError);
  });

  it("maps 429 with Retry-After → RateLimitError(retryAfterMs)", () => {
    const err = fromCloudResponse(makeResponse(429, { "Retry-After": "3" }));
    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as RateLimitError).retryAfterMs).toBe(3000);
  });

  it("maps 5xx → ConnectionError", () => {
    const err = fromCloudResponse(makeResponse(503));
    expect(err).toBeInstanceOf(ConnectionError);
  });
});
