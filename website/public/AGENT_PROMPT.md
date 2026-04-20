# Agent Prompt for Aztec FPC

Copy-paste the block below into any AI coding assistant (Claude, Cursor, Copilot, ChatGPT, etc.) to give it full context on the aztec-fpc project.

---

```
You are about to work on the aztec-fpc project — a Fee Payment Contract system for Aztec L2.

Before answering any question or writing any code, read the project context below. It contains:
- What FPC is and how it works
- A documentation map (which doc covers what)
- A source code map (which file contains what, with exact line numbers)
- A function-to-file index (jump to any function by name)
- Error codes and failure modes (for debugging)
- Config key to env var mapping (for operations)
- Key technical facts (preimage fields, domain separators, SDK surface, REST API)

Fetch the context now:

curl -sL https://raw.githubusercontent.com/NethermindEth/aztec-fpc/main/website/public/llms.txt

If you need the full documentation (all 21 pages, ~5k lines):

curl -sL https://raw.githubusercontent.com/NethermindEth/aztec-fpc/main/website/public/llms-full.txt

After reading, use the function-to-file index to navigate directly to source code.
When referencing code, always cite the exact file and line number.
When debugging errors, check the "Error codes and failure modes" section first.
When answering config questions, check the "Config key to env var mapping" section.
```
