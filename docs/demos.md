# dsh-baton demos

English | [中文](demos.zh-CN.md) · [Back to README](../README.md)

Each demo shows the calling agent on the left and DeepSeek Harness on the right. Waits are sped up.

## Quick task from Codex

Codex desktop opens a DeepSeek session, has it write a palindrome function and 3 tests, runs them and reports the result.

<p align="center">
  <img src="../assets/demos/s1-quick-en.gif" width="100%" alt="Codex desktop sends a task to a new DeepSeek session, which writes a palindrome function with 3 tests, runs them and reports back">
</p>

## Long task, wait, then review

DeepSeek builds a to-do list web page. Codex waits until it is done, then reviews the result.

<p align="center">
  <img src="../assets/demos/s2-todo-en.gif" width="100%" alt="Codex hands DeepSeek a to-do list page, waits for the run to finish, then reviews the result">
</p>

## Queue and steer from Claude Code

Claude Code starts a task, queues a follow-up and steers the running turn.

<p align="center">
  <img src="../assets/demos/s3-queue-claude-en.gif" width="100%" alt="Claude Code starts a DeepSeek task, queues a follow-up and steers the running turn">
</p>

## Cancel from the Codex CLI

The Codex CLI sends a task and cancels it at once with `dsh_cancel`. The run ends as `cancelled`.

<p align="center">
  <img src="../assets/demos/s7-cancel-en.gif" width="100%" alt="Codex CLI sends a task, calls dsh_cancel right away, and the run state becomes cancelled">
</p>

## Codex and Claude in one session

Codex and Claude take turns sending to the same Harness session. This is the full version with the Codex window.

<p align="center">
  <img src="../assets/demos/s8-relay-en.gif" width="100%" alt="Codex on the left and Claude take turns sending to the same Harness session; each message is labelled with its sender">
</p>
