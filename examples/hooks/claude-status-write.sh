#!/usr/bin/env bash
# Claude Code (and GLM-via-Claude) → Agent Stage StatusSnapshotV1
#
# Install (user settings ~/.claude/settings.json), example:
# {
#   "hooks": {
#     "PermissionRequest": [{ "hooks": [{ "type": "command", "command": "/ABS/PATH/claude-status-write.sh" }] }],
#     "Notification": [{ "hooks": [{ "type": "command", "command": "/ABS/PATH/claude-status-write.sh" }] }],
#     "Stop": [{ "hooks": [{ "type": "command", "command": "/ABS/PATH/claude-status-write.sh" }] }],
#     "StopFailure": [{ "hooks": [{ "type": "command", "command": "/ABS/PATH/claude-status-write.sh" }] }],
#     "SessionStart": [{ "hooks": [{ "type": "command", "command": "/ABS/PATH/claude-status-write.sh" }] }],
#     "SessionEnd": [{ "hooks": [{ "type": "command", "command": "/ABS/PATH/claude-status-write.sh" }] }]
#   }
# }
#
# Env:
#   AGENT_STAGE_ID   roster agent id (default: claude-main; use glm-1 for GLM)
#   AGENT_STAGE_HOME default ~/.agent-stage
#   AGENT_STAGE_VENDOR  claude-code | glm (default claude-code)
set -euo pipefail

AGENT_ID="${AGENT_STAGE_ID:-claude-main}"
VENDOR="${AGENT_STAGE_VENDOR:-claude-code}"
HOME_DIR="${AGENT_STAGE_HOME:-$HOME/.agent-stage}"
STATUS_DIR="$HOME_DIR/status"
mkdir -p "$STATUS_DIR"

INPUT=$(cat || true)

if command -v jq >/dev/null 2>&1; then
  HOOK=$(printf '%s' "$INPUT" | jq -r '.hook_event_name // empty')
  NOTIF=$(printf '%s' "$INPUT" | jq -r '.notification_type // empty')
  SESSION=$(printf '%s' "$INPUT" | jq -r '.session_id // empty')
  FAIL=$(printf '%s' "$INPUT" | jq -r '.error_type // .matcher // empty')
else
  HOOK=""; NOTIF=""; SESSION=""; FAIL=""
fi

STATUS="running"
SUMMARY="${VENDOR}: ${HOOK:-active}"

case "$HOOK" in
  PermissionRequest)
    STATUS="needs_input"
    SUMMARY="Permission request"
    ;;
  Notification)
    case "$NOTIF" in
      *auth*|*Auth*) STATUS="needs_auth"; SUMMARY="Auth: $NOTIF" ;;
      agent_needs_input|*permission*|*elicitation*)
        STATUS="needs_input"; SUMMARY="Needs input: $NOTIF" ;;
      *completed*|agent_completed)
        STATUS="done"; SUMMARY="Completed" ;;
      *) STATUS="running"; SUMMARY="Notify: ${NOTIF:-ok}" ;;
    esac
    ;;
  Stop) STATUS="done"; SUMMARY="Turn stopped" ;;
  StopFailure)
    case "$FAIL" in
      authentication_failed|*oauth*|*credential*|*auth*)
        STATUS="needs_auth"; SUMMARY="Auth failure: $FAIL" ;;
      *) STATUS="error"; SUMMARY="StopFailure: ${FAIL:-unknown}" ;;
    esac
    ;;
  SessionEnd) STATUS="idle"; SUMMARY="Session ended" ;;
  SessionStart|UserPromptSubmit) STATUS="running"; SUMMARY="Session active" ;;
esac

OUT="$STATUS_DIR/${AGENT_ID}.json"
TMP="$OUT.tmp.$$"
OBSERVED=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)

if command -v jq >/dev/null 2>&1; then
  jq -n \
    --arg id "$AGENT_ID" \
    --arg status "$STATUS" \
    --arg summary "$SUMMARY" \
    --arg observed "$OBSERVED" \
    --arg session "$SESSION" \
    --arg hook "$HOOK" \
    --arg vendor "$VENDOR" \
    '{
      schemaVersion: 1,
      agentId: $id,
      status: $status,
      summary: $summary,
      observedAt: $observed,
      vendor: $vendor,
      sessionId: (if $session == "" then null else $session end),
      meta: { hook: $hook }
    }' > "$TMP"
else
  # Minimal JSON without jq
  printf '{"schemaVersion":1,"agentId":"%s","status":"%s","summary":"%s","observedAt":"%s","vendor":"%s"}\n' \
    "$AGENT_ID" "$STATUS" "$SUMMARY" "$OBSERVED" "$VENDOR" > "$TMP"
fi
mv "$TMP" "$OUT"
