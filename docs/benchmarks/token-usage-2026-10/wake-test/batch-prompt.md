# Batch wake test (0.6.1 after 6bdd3b9)

Codex desktop, new conversation in the dsh-baton-test project (folder reset to 56163d4), model GPT-6 Luna · Medium. Pasted as is:

```
把下面三件小事交给 DeepSeek Harness 并行去做，每件开一个独立会话，各自只写自己的文件：
1. hello.txt：写一行"你好，雨夜"。
2. primes.mjs：导出一个函数，返回前 N 个素数；直接运行时打印前 50 个。再写 primes.test.mjs，用 node --test 测试。
3. story.md：写一篇约 1,500 字的中文短篇，讲雨夜里便利店的店员和一位常客，分 5 个小节，每节有小标题；写完自己通读一遍，改掉错别字。
三件都交回后再一起检查。然后给写 story.md 的那个会话发一条具体的修改意见（把结尾改成开放式），等它改完交回后，再给我一个简短总结。
```

What to check in the rollout and `~/.dsh-baton/codex-hook/`:
1. After the three `dsh_send` calls the turn ends; no `dsh_wait`, no polling.
2. One wake only, after the last of the three runs ends (story.md takes longest), carrying all three results; hello.txt finishing first does not wake Codex.
3. In that woken turn the rework `dsh_send` (to the existing story session) gets "End your turn now", and the turn ends.
4. A second wake when the rework ends; then the summary.
