# SETUP

Instructions for an agent that sets up dsh-superagent with its operator. If you are a person, ask your coding agent to read this file and follow it.

## How to run the setup

The setup follows [docs/000-philosophy.md](docs/000-philosophy.md): it takes as little of the operator's attention as possible.

- **Before the first question,** read only this file and `docs/000-philosophy.md`, and run the probe below once. Read nothing else until every answer is collected.
- **Ask one question per message,** about one thing. Wait for the answer before the next one. Skip a question the probe already answers.
- **Keep each message under 300 words,** unless the operator asks for more. Give each question a recommended answer the operator can accept with one word, and one sentence on why it matters.
- **Do not execute while asking.** Collect every answer, then send one message with the full plan, and execute only after the operator confirms it.
- **Never ask for a secret in the chat.** Steps that need the operator's hands, such as creating an account, signing a CLI in or entering an app secret, go into one message with the exact commands to run in their own terminal.
- **Teach the philosophy through the questions,** one sentence at a time, not as a lecture.

## 1. Probe

Run from this checkout, once, and keep the result to yourself:

```sh
git --version
gh --version | head -1
gh api user --jq .login
command -v lark-cli
grep -l -E 'id: dsh-superagent\b' "${DSH_HOME:-$HOME/.dsh}"/profiles/*/cordis.patch.yml 2>/dev/null
```

- **Prerequisites:** DeepSeek Harness desktop within the `engines.dsh` range of `package.json`, git 2.32+ and GitHub CLI 2.48+. A missing one becomes an item of the plan, not a question. DSH also needs a model provider; if the operator has never run DSH with a model, configuring one is an operator step.
- **Operator login:** the `gh api user` result is the operator's own GitHub login, used as the recommendation in question 5.
- **Existing profile:** If the desktop profile already has a `dsh-superagent` entry, keep its configuration and follow Upgrade in `docs/006-deployment.md`. Follow the migration instructions for an earlier standalone instance.

## 2. Questions

Ask in this order, one per message, following the flow of work in [docs/001-domain.md](docs/001-domain.md): first where Triggers come from, then who may ask for work there, then what the Executor does with a Ticket. Recommendations are in brackets.

**Sources: where requests come from.**

1. **Sources.** Should the agent take requests from GitHub only, or also from Feishu chats? [GitHub only, unless the team works in Feishu.]
2. **Repository.** Which github.com repository should the agent work on, as `owner/name`?
3. **Agent account.** Which GitHub user account will the agent act as? [A dedicated account, never the operator's own: everything the agent writes appears under this name.] It may not exist yet; creating it is an operator step.
4. With Feishu: **which chats,** by name? The agent looks up their ids after the bot is configured.

**Policy: who may ask for work.**

5. **On GitHub.** Which GitHub logins may ask the agent for work? [Only `<operator login>`: the agent acts only for people on this list, and a short list keeps the team's noise low while the operator learns how the agent behaves.]
6. With Feishu: **who may ask in Feishu?** [Everyone in the first chat, kept in sync with its members.]

**Execution: what the agent does with a Ticket.**

7. **Checkout.** Which local clone of the repository should each Ticket check out from? [A new clone under `~/src/<name>`.]
8. **Commit identity.** Who should the agent's commits name as author? [The agent account, so its work is visibly its own.] Another identity, such as the operator's, goes into the Delivery requirements prompt section.
9. **Auto-merge.** Should the agent enable auto-merge on its own pull requests once they are ready and approved? [No: people merge until the agent's pull requests have been right for a while.] The agent never enables it as the agent account, so with yes it needs the GitHub CLI of another account that may merge: ask the operator to sign one in among the operator steps, and name it in Delivery requirements. With no, remove the auto-merge paragraph from Delivery requirements.

Do not ask about values with a good default; list them in the plan instead:

- the Superagent panel in the DeepSeek Harness desktop client and state directory `<home>/.dsh/state/dsh-superagent` for new installations;
- branch prefix `agent/`;
- accept mode `observe`, which records proactive work without doing it, and the default rules and prompt sections;
- with Feishu: the bot reads only mentions, and direct messages are on.

## 3. Plan

Send one message, under 300 words: what will be installed, the accounts and CLIs, the settings to save, the operator steps, and the defaults. Ask for one confirmation.

## 4. Execute

1. **Operator steps first.** Read the Accounts section of `docs/006-deployment.md`, write the CLI wrappers yourself, then send one message with what only the operator can do: create the agent account and, with auto-merge, sign a CLI in as the account that enables it, accept the repository invitation as the agent account, run `auth login` for each wrapper, and for Feishu create and publish the bot app and run the `config init` command with its secret. Wait until the operator says it is done, then check each login with `<wrapper> api user --jq .login`.
2. **Install and open.** Follow Install and Machine configuration in `docs/006-deployment.md`. Open **Superagent** in the desktop sidebar. Clone the project repository if question 7 called for a new clone.
3. **Settings.** In the desktop panel, configure GitHub and optional Feishu under **Sources**, set the allowed lists under **Eval**, and add a prepare command under **Execution**. Look up Feishu chat IDs with the bot CLI. Set the commit identity and auto-merge preference in **Prompts → Delivery requirements**. If an account change reloads the plugin, wait until the panel reconnects before the next save.
4. **Failures.** A refused save shows the setup problem in the panel. Find it in the Troubleshooting table of `docs/006-deployment.md`, fix it, and continue. Ask the operator only for what you cannot fix yourself.

## 5. Verify and hand over

Check the desktop panel for setup problems and the connected Source account. Then send one message under 300 words.

- The location of **Superagent** in the DeepSeek Harness desktop sidebar.
- How to try it: from an account on the allowed list, comment `@<agent login> <request>` on an issue in the repository. A Ticket appears on the overview within about a minute.
- Three rules for the operator, from the Responsibility section of `docs/000-philosophy.md`: start narrow, tune for less noise, own what the agent says.
- Where to read more: the numbered documents in `docs/`, in order.
