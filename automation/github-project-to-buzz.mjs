import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

import { finalizeEvent, getPublicKey, nip19 } from "nostr-tools";

export const DEFAULT_RELAY_URL = "wss://flint.communities.buzz.xyz/";
export const DEFAULT_TARGET_STATUS = "Ready for Design";
export const MARKER_PREFIX = "buzz-project-to-buzz:v1";
const CONNECT_TIMEOUT_MS = 10_000;
const AUTH_TIMEOUT_MS = 10_000;
const RECOVERY_QUERY_TIMEOUT_MS = 5_000;
const WRITE_TIMEOUT_MS = 15_000;
const MAX_MESSAGE_BYTES = 60_000;
const MARKER_PATTERN = new RegExp(
  `<!-- ${MARKER_PREFIX} state=(pending|retry|ready) channel=([0-9a-f-]{36})(?: message=([0-9a-f]{64}))? -->`,
);

const PROJECT_ITEMS_QUERY = `
  query ReadyForDesignItems($login: String!, $number: Int!, $after: String) {
    user(login: $login) {
      projectV2(number: $number) {
        items(first: 100, after: $after) {
          nodes {
            content {
              __typename
              ... on Issue {
                id
                number
                title
                body
                url
                repository {
                  nameWithOwner
                }
              }
            }
            fieldValueByName(name: "Status") {
              ... on ProjectV2ItemFieldSingleSelectValue {
                name
              }
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    }
  }
`;

function requiredEnv(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function apiHeaders(token) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function readJsonResponse(response, label) {
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  if (!response.ok) {
    const detail =
      body && typeof body === "object" && "message" in body
        ? `: ${body.message}`
        : "";
    throw new Error(`${label} failed with HTTP ${response.status}${detail}`);
  }

  return body;
}

async function githubRequest(
  url,
  { token, method = "GET", body, fetchImpl = fetch, label = "GitHub request" },
) {
  const response = await fetchImpl(url, {
    method,
    headers: apiHeaders(token),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return readJsonResponse(response, label);
}

export async function findReadyIssues({
  projectOwner,
  projectNumber,
  targetStatus = DEFAULT_TARGET_STATUS,
  targetRepository,
  issueNumber,
  projectToken,
  fetchImpl = fetch,
}) {
  const issues = [];
  let after = null;

  do {
    const response = await githubRequest("https://api.github.com/graphql", {
      token: projectToken,
      method: "POST",
      body: {
        query: PROJECT_ITEMS_QUERY,
        variables: { login: projectOwner, number: projectNumber, after },
      },
      fetchImpl,
      label: "GitHub Projects query",
    });

    if (response.errors?.length) {
      throw new Error(
        `GitHub Projects query failed: ${response.errors
          .map((error) => error.message)
          .join("; ")}`,
      );
    }

    const project = response.data?.user?.projectV2;
    if (!project) {
      throw new Error(
        `GitHub Project ${projectOwner}/${projectNumber} was not found or is not readable.`,
      );
    }

    const connection = project.items;
    for (const item of connection.nodes ?? []) {
      const content = item.content;
      if (
        content?.__typename !== "Issue" ||
        item.fieldValueByName?.name !== targetStatus ||
        content.repository?.nameWithOwner !== targetRepository ||
        (issueNumber && content.number !== issueNumber)
      ) {
        continue;
      }

      issues.push({
        id: content.id,
        number: content.number,
        title: content.title,
        body: content.body ?? "",
        url: content.url,
        repository: content.repository.nameWithOwner,
      });
    }

    after = connection.pageInfo?.hasNextPage
      ? connection.pageInfo.endCursor
      : null;
  } while (after);

  return issues;
}

export function parseBridgeMarker(body) {
  if (typeof body !== "string") return null;
  const match = body.match(MARKER_PATTERN);
  if (!match) return null;
  return {
    state: match[1],
    channelId: match[2],
    messageId: match[3] ?? null,
  };
}

function marker({ state, channelId, messageId }) {
  const message = messageId ? ` message=${messageId}` : "";
  return `<!-- ${MARKER_PREFIX} state=${state} channel=${channelId}${message} -->`;
}

export function buildPendingComment(channelId) {
  return [
    "Creating the Buzz collaboration channel…",
    "",
    marker({ state: "pending", channelId }),
  ].join("\n");
}

export function buildRetryComment(channelId) {
  return [
    "The Buzz bridge did not finish. It will retry automatically.",
    "",
    marker({ state: "retry", channelId }),
  ].join("\n");
}

export function buildReadyComment({ channelId, messageId }) {
  const deepLink = buildBuzzDeepLink({ channelId, messageId });
  return [
    `Buzz collaboration channel: [Open in Buzz](${deepLink})`,
    "",
    deepLink,
    "",
    marker({ state: "ready", channelId, messageId }),
  ].join("\n");
}

export function buildBuzzDeepLink({ channelId, messageId }) {
  const query = new URLSearchParams({ channel: channelId, id: messageId });
  return `buzz://message?${query.toString()}`;
}

export function normalizeChannelName(issue) {
  const title = issue.title
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return (title || `${issue.repository} issue ${issue.number}`).slice(0, 120);
}

function truncateUtf8(value, maxBytes) {
  const encoded = new TextEncoder().encode(value);
  if (encoded.byteLength <= maxBytes) return value;
  return new TextDecoder().decode(encoded.slice(0, maxBytes)).replace(/\uFFFD$/u, "");
}

export function buildSeedMessage(issue) {
  const header = `# ${normalizeChannelName(issue)}\n\n`;
  const footer = `\n\n---\nGitHub issue: <${issue.url}>`;
  const emptyBody = "_No issue description provided._";
  const body = issue.body.trim() || emptyBody;
  const reservedBytes = Buffer.byteLength(header + footer + "\n\n_[Issue body truncated.]_");
  const maxBodyBytes = Math.max(0, MAX_MESSAGE_BYTES - reservedBytes);
  const truncated = truncateUtf8(body, maxBodyBytes);
  const suffix = truncated === body ? "" : "\n\n_[Issue body truncated.]_";
  return `${header}${truncated}${suffix}${footer}`;
}

export function decodeSecretKey(value) {
  const secret = value.trim();
  if (/^[0-9a-f]{64}$/iu.test(secret)) {
    return Uint8Array.from(Buffer.from(secret, "hex"));
  }
  if (secret.startsWith("nsec1")) {
    try {
      const decoded = nip19.decode(secret);
      if (decoded.type === "nsec" && decoded.data instanceof Uint8Array) {
        return decoded.data;
      }
    } catch {
      // Replace decoder details with a generic error so the secret cannot leak.
    }
  }
  throw new Error("BUZZ_PRIVATE_KEY must be a valid nsec or 64-character hex key.");
}

function hasTag(event, name, value) {
  return event.tags?.some((tag) => tag[0] === name && tag[1] === value);
}

function isExistingChannelReason(reason) {
  return typeof reason === "string" && /already|exists|duplicate/iu.test(reason);
}

export function publishIssueToBuzz({
  issue,
  channelId,
  secretKey,
  relayUrl = DEFAULT_RELAY_URL,
  socketFactory = (url) => new WebSocket(url),
  connectTimeoutMs = CONNECT_TIMEOUT_MS,
  authTimeoutMs = AUTH_TIMEOUT_MS,
  recoveryQueryTimeoutMs = RECOVERY_QUERY_TIMEOUT_MS,
  writeTimeoutMs = WRITE_TIMEOUT_MS,
  now = () => Math.floor(Date.now() / 1000),
  logger = console.log,
}) {
  const channelName = normalizeChannelName(issue);
  const author = getPublicKey(secretKey);
  const socket = socketFactory(relayUrl);

  return new Promise((resolve, reject) => {
    let settled = false;
    let authEventId = "";
    let createEventId = "";
    let seedEventId = "";
    let existingMessageId = "";
    let queryFinished = false;
    let phase = "connecting";
    let timer = null;
    const subscriptionId = `github-issue-${issue.number}-${channelId.slice(0, 8)}`;

    function cleanup() {
      if (timer !== null) globalThis.clearTimeout(timer);
      if (socket.readyState < 2) socket.close(1000);
    }

    function armTimeout(timeoutMs, reason, onTimeout = fail) {
      if (timer !== null) globalThis.clearTimeout(timer);
      timer = globalThis.setTimeout(() => onTimeout(reason), timeoutMs);
    }

    function fail(reason) {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(reason));
    }

    function succeed(messageId, recovered = false) {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ channelId, channelName, messageId, recovered });
    }

    function sendCreateChannel() {
      phase = "creating the channel";
      logger("Buzz relay: creating the reserved channel.");
      const event = finalizeEvent(
        {
          kind: 9007,
          created_at: now(),
          content: "",
          tags: [
            ["h", channelId],
            ["name", channelName],
            ["visibility", "open"],
            ["channel_type", "stream"],
          ],
        },
        secretKey,
      );
      createEventId = event.id;
      socket.send(JSON.stringify(["EVENT", event]));
      armTimeout(
        writeTimeoutMs,
        `The Buzz relay did not confirm channel creation within ${writeTimeoutMs}ms.`,
      );
    }

    function sendSeedMessage() {
      phase = "posting the issue";
      logger("Buzz relay: posting the issue to the channel.");
      const event = finalizeEvent(
        {
          kind: 9,
          created_at: now(),
          content: buildSeedMessage(issue),
          tags: [
            ["h", channelId],
            ["r", issue.url],
          ],
        },
        secretKey,
      );
      seedEventId = event.id;
      socket.send(JSON.stringify(["EVENT", event]));
      armTimeout(
        writeTimeoutMs,
        `The Buzz relay did not confirm the issue message within ${writeTimeoutMs}ms.`,
      );
    }

    function finishRecoveryQuery(timedOut = false) {
      if (queryFinished) return;
      queryFinished = true;
      if (timer !== null) globalThis.clearTimeout(timer);
      socket.send(JSON.stringify(["CLOSE", subscriptionId]));
      if (existingMessageId) {
        logger("Buzz relay: recovered the existing issue message.");
        succeed(existingMessageId, true);
        return;
      }
      if (timedOut) {
        logger(
          `Buzz relay: recovery query did not finish within ${recoveryQueryTimeoutMs}ms; continuing with the reserved channel.`,
        );
      } else {
        logger("Buzz relay: no existing issue message found.");
      }
      sendCreateChannel();
    }

    logger("Buzz relay: connecting.");
    armTimeout(
      connectTimeoutMs,
      `The Buzz relay connection did not open within ${connectTimeoutMs}ms.`,
    );
    socket.onopen = () => {
      phase = "waiting for authentication";
      logger("Buzz relay: connected; waiting for an authentication challenge.");
      armTimeout(
        authTimeoutMs,
        `The Buzz relay did not issue an authentication challenge within ${authTimeoutMs}ms.`,
      );
    };
    socket.onerror = () => fail(`The Buzz relay failed while ${phase}.`);
    socket.onclose = () => {
      if (!settled) fail(`The Buzz relay closed while ${phase}.`);
    };
    socket.onmessage = (raw) => {
      let message;
      try {
        message = JSON.parse(String(raw.data));
      } catch {
        return;
      }
      if (!Array.isArray(message) || typeof message[0] !== "string") return;

      if (message[0] === "AUTH" && typeof message[1] === "string" && !authEventId) {
        phase = "authenticating";
        logger("Buzz relay: authentication challenge received.");
        const event = finalizeEvent(
          {
            kind: 22242,
            created_at: now(),
            content: "",
            tags: [
              ["relay", relayUrl],
              ["challenge", message[1]],
            ],
          },
          secretKey,
        );
        authEventId = event.id;
        socket.send(JSON.stringify(["AUTH", event]));
        armTimeout(
          authTimeoutMs,
          `The Buzz relay did not confirm authentication within ${authTimeoutMs}ms.`,
        );
        return;
      }

      if (message[0] === "NOTICE") {
        fail(typeof message[1] === "string" ? message[1] : "The Buzz relay rejected the request.");
        return;
      }

      if (message[0] === "EVENT" && message[1] === subscriptionId) {
        const event = message[2];
        if (
          event?.kind === 9 &&
          event.pubkey === author &&
          hasTag(event, "h", channelId) &&
          hasTag(event, "r", issue.url)
        ) {
          existingMessageId = event.id;
        }
        return;
      }

      if (message[0] === "EOSE" && message[1] === subscriptionId) {
        finishRecoveryQuery();
        return;
      }

      if (message[0] !== "OK") return;
      const [, eventId, accepted, reason] = message;

      if (eventId === authEventId) {
        if (!accepted) {
          fail(reason || "The Buzz relay rejected authentication.");
          return;
        }
        phase = "checking for an existing issue message";
        logger("Buzz relay: authenticated; checking for an existing issue message.");
        socket.send(
          JSON.stringify([
            "REQ",
            subscriptionId,
            { kinds: [9], authors: [author], "#h": [channelId], limit: 100 },
          ]),
        );
        armTimeout(
          recoveryQueryTimeoutMs,
          "Recovery query timed out.",
          () => finishRecoveryQuery(true),
        );
        return;
      }

      if (eventId === createEventId) {
        if (seedEventId) return;
        if (!accepted && !isExistingChannelReason(reason)) {
          fail(reason || "The Buzz relay could not create the channel.");
          return;
        }
        logger(
          accepted
            ? "Buzz relay: channel created."
            : "Buzz relay: reserved channel already exists; continuing.",
        );
        sendSeedMessage();
        return;
      }

      if (eventId === seedEventId) {
        if (!accepted) {
          fail(reason || "The Buzz relay rejected the issue message.");
          return;
        }
        logger("Buzz relay: issue message accepted.");
        succeed(seedEventId);
      }
    };
  });
}

async function listIssueComments({ issue, issueToken, fetchImpl }) {
  const comments = [];
  const [owner, repo] = issue.repository.split("/");
  let page = 1;

  while (true) {
    const url = `https://api.github.com/repos/${owner}/${repo}/issues/${issue.number}/comments?per_page=100&page=${page}`;
    const batch = await githubRequest(url, {
      token: issueToken,
      fetchImpl,
      label: `Read comments for ${issue.repository}#${issue.number}`,
    });
    comments.push(...batch);
    if (batch.length < 100) return comments;
    page += 1;
  }
}

async function createIssueComment({ issue, issueToken, body, fetchImpl }) {
  const [owner, repo] = issue.repository.split("/");
  return githubRequest(
    `https://api.github.com/repos/${owner}/${repo}/issues/${issue.number}/comments`,
    {
      token: issueToken,
      method: "POST",
      body: { body },
      fetchImpl,
      label: `Create comment for ${issue.repository}#${issue.number}`,
    },
  );
}

async function updateIssueComment({ issue, commentId, issueToken, body, fetchImpl }) {
  const [owner, repo] = issue.repository.split("/");
  return githubRequest(
    `https://api.github.com/repos/${owner}/${repo}/issues/comments/${commentId}`,
    {
      token: issueToken,
      method: "PATCH",
      body: { body },
      fetchImpl,
      label: `Update bridge comment for ${issue.repository}#${issue.number}`,
    },
  );
}

export async function processIssue({
  issue,
  issueToken,
  secretKey,
  relayUrl,
  fetchImpl = fetch,
  publisher = publishIssueToBuzz,
  uuid = randomUUID,
}) {
  const comments = await listIssueComments({ issue, issueToken, fetchImpl });
  const bridgeComments = comments
    .map((comment) => ({ comment, marker: parseBridgeMarker(comment.body) }))
    .filter(
      ({ comment, marker: value }) =>
        value && comment.user?.login === "github-actions[bot]",
    );
  const completed = bridgeComments.find(({ marker: value }) => value.state === "ready");
  if (completed) {
    return {
      status: "skipped",
      channelId: completed.marker.channelId,
      messageId: completed.marker.messageId,
    };
  }

  let reservation = bridgeComments[0];
  if (!reservation) {
    const channelId = uuid();
    const comment = await createIssueComment({
      issue,
      issueToken,
      body: buildPendingComment(channelId),
      fetchImpl,
    });
    reservation = { comment, marker: { state: "pending", channelId, messageId: null } };
  }

  try {
    const result = await publisher({
      issue,
      channelId: reservation.marker.channelId,
      secretKey,
      relayUrl,
    });
    await updateIssueComment({
      issue,
      commentId: reservation.comment.id,
      issueToken,
      body: buildReadyComment(result),
      fetchImpl,
    });
    return { status: result.recovered ? "recovered" : "created", ...result };
  } catch (error) {
    try {
      await updateIssueComment({
        issue,
        commentId: reservation.comment.id,
        issueToken,
        body: buildRetryComment(reservation.marker.channelId),
        fetchImpl,
      });
    } catch (commentError) {
      console.error(`Could not mark ${issue.repository}#${issue.number} for retry:`, commentError);
    }
    throw error;
  }
}

export async function runBridge({ env = process.env, fetchImpl = fetch, publisher } = {}) {
  const projectOwner = requiredEnv(env, "PROJECT_OWNER");
  const targetRepository = requiredEnv(env, "TARGET_REPOSITORY");
  const projectToken = requiredEnv(env, "PROJECT_TOKEN");
  const issueToken = requiredEnv(env, "GITHUB_TOKEN");
  const secretKey = decodeSecretKey(requiredEnv(env, "BUZZ_PRIVATE_KEY"));
  const projectNumber = Number.parseInt(requiredEnv(env, "PROJECT_NUMBER"), 10);
  if (!Number.isSafeInteger(projectNumber) || projectNumber < 1) {
    throw new Error("PROJECT_NUMBER must be a positive integer.");
  }

  const issueNumberValue = env.ISSUE_NUMBER?.trim();
  const issueNumber = issueNumberValue ? Number.parseInt(issueNumberValue, 10) : null;
  if (issueNumberValue && (!Number.isSafeInteger(issueNumber) || issueNumber < 1)) {
    throw new Error("ISSUE_NUMBER must be a positive integer when provided.");
  }

  const relayUrl = env.BUZZ_RELAY_URL?.trim() || DEFAULT_RELAY_URL;
  const targetStatus = env.TARGET_STATUS?.trim() || DEFAULT_TARGET_STATUS;
  const issues = await findReadyIssues({
    projectOwner,
    projectNumber,
    targetStatus,
    targetRepository,
    issueNumber,
    projectToken,
    fetchImpl,
  });

  if (issues.length === 0) {
    console.log(`No ${targetRepository} issues are currently in ${targetStatus}.`);
    return [];
  }

  const results = [];
  const failures = [];
  for (const issue of issues) {
    try {
      const result = await processIssue({
        issue,
        issueToken,
        secretKey,
        relayUrl,
        fetchImpl,
        publisher,
      });
      results.push({ issue: issue.number, ...result });
      console.log(`${issue.repository}#${issue.number}: ${result.status}`);
    } catch (error) {
      failures.push(error);
      console.error(`${issue.repository}#${issue.number}: failed`, error);
    }
  }

  if (failures.length) {
    throw new AggregateError(failures, `${failures.length} issue handoff(s) failed.`);
  }
  return results;
}

const isEntrypoint =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntrypoint) {
  runBridge().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
