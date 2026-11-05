# Copyright Sierra

import json
import textwrap
import uuid
from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field
from typing_extensions import Annotated

from tau2.data_model.message import Message, ToolCall, ToolRequestor


class StructuredUserInstructions(BaseModel):
    """
    User instructions. This information defines the specific situation the user is in and the tasks they are trying to complete.
    """

    domain: Annotated[str, Field(description="The domain of the task.")]
    reason_for_call: Annotated[
        str, Field(description="The reason for the user to call the agent.")
    ]
    known_info: Annotated[
        Optional[str],
        Field(description="Known information about the user.", default=None),
    ]
    unknown_info: Annotated[
        Optional[str],
        Field(description="Unknown information about the user.", default=None),
    ]
    task_instructions: Annotated[str, Field(description="Instructions for the User.")]

    def __str__(self) -> str:
        lines = []
        tab = "\t"
        lines.append(f"Domain: {self.domain}")
        lines.append(f"Reason for call:\n{textwrap.indent(self.reason_for_call, tab)}")
        if self.known_info is not None:
            lines.append(f"Known info:\n{textwrap.indent(self.known_info, tab)}")
        if self.unknown_info is not None:
            lines.append(f"Unknown info:\n{textwrap.indent(self.unknown_info, tab)}")
        lines.append(
            f"Task instructions:\n{textwrap.indent(self.task_instructions, tab)}"
        )
        return "\n".join(lines)


UserInstructions = StructuredUserInstructions | str


class UserScenario(BaseModel):
    """
    User scenario. All the information that will be sent to the user simulator.
    """

    persona: Annotated[
        Optional[str],
        Field(
            description="User's persona. This information defines the user in general, not the specific situation they are in.",
            default=None,
        ),
    ]
    instructions: Annotated[
        UserInstructions,
        Field(
            description="Instructions for the User. This information defines the specific situation the user is in and the tasks they are trying to complete."
        ),
    ]

    def __str__(self) -> str:
        lines = []
        if self.persona is not None:
            lines.append("Persona:")
            lines.append(textwrap.indent(self.persona, "\t"))
        lines.append("Instructions:")
        lines.append(textwrap.indent(str(self.instructions), "\t"))
        return "\n".join(lines)


class Description(BaseModel):
    """
    Description of a scenario. This can be sent to the evaluator.
    """

    purpose: Annotated[
        Optional[str],
        Field(description="Explains what the scenario is testing.", default=None),
    ]
    relevant_policies: Annotated[
        Optional[str],
        Field(
            description="The part of the policy that is relevant to the scenario.",
            default=None,
        ),
    ]
    notes: Annotated[
        Optional[str],
        Field(
            description="Any additional information about the scenario that is not covered by the other fields.",
            default=None,
        ),
    ]

    def __str__(self) -> str:
        lines = []
        if self.purpose is not None:
            lines.append(f"Purpose: {self.purpose}")
        if self.relevant_policies is not None:
            lines.append(f"Relevant Policies: {self.relevant_policies}")
        if self.notes is not None:
            lines.append(f"Notes: {self.notes}")
        return "\n".join(lines)


class Action(BaseModel):
    """
    Descriptor for a tool call by the agent or the user.

    Used in two contexts:

    - `EvaluationCriteria.actions`: one reference trajectory replayed to
      derive the target DB end state. Not a per-call requirement on the
      agent unless `RewardType.ACTION` is in `reward_basis`. See
      `docs/evaluation.md`.
    - `InitialState.initialization_actions`: replayed before the
      simulation to set up the initial state.

    `compare_with_tool_call` matches an action against a tool call using
    `compare_args` (or all arguments if `compare_args` is None). It is
    only consulted by `ActionEvaluator`.

    Example:
      {
        "action_id": "get_user_details_1",
        "requestor": "assistant",
        "name": "get_user_details",
        "arguments": {"user_id": "sophia_silva_7557"},
        "compare_args": ["user_id"]
      }
    """

    action_id: str = Field(
        description="The unique identifier for the action within a scenario."
    )
    requestor: ToolRequestor = Field(
        description="The requestor of the action.",
        default="assistant",
    )
    name: str = Field(description="The name of the action.")
    arguments: dict = Field(description="The arguments for the action.")
    info: Optional[str] = Field(
        description="Information about the action.", default=None
    )
    compare_args: Optional[list[str]] = Field(
        description="The arguments to check in tool call. If None, will check all the arguments.",
        default=None,
    )

    def __str__(self) -> str:
        lines = []
        lines.append(f"Action ID: {self.action_id}")
        lines.append(f"Requestor: {self.requestor}")
        lines.append(f"Name: {self.name}")
        lines.append(f"Arguments:\n{json.dumps(self.arguments, indent=2)}")
        if self.info is not None:
            lines.append(f"Info:\n{textwrap.indent(self.info, '    ')}")
        return "\n".join(lines)

    def get_func_format(self) -> str:
        """
        Get the function format of the action.
        """
        return (
            f"{self.name}({', '.join([f'{k}={v}' for k, v in self.arguments.items()])})"
        )

    def compare_with_tool_call(self, tool_call: ToolCall) -> bool:
        """
        Compare the action with a tool call.
        If the name is not the same, return False.
        If compare_args is None, will check all the arguments.
        Otherwise, will check only the arguments in compare_args.
        """
        if self.name != tool_call.name:
            return False
        if self.compare_args is None:
            compare_args = tool_call.arguments.keys()
        else:
            compare_args = self.compare_args
        if len(compare_args) == 0:
            return True
        tool_args = {k: v for k, v in tool_call.arguments.items() if k in compare_args}
        action_args = {k: v for k, v in self.arguments.items() if k in compare_args}
        return tool_args == action_args


class EnvFunctionCall(BaseModel):
    """
    A function call on the agent or user environment.
    """

    env_type: Annotated[
        ToolRequestor,
        Field(description="The type of environment to call the function on."),
    ]
    func_name: Annotated[str, Field(description="The name of the function to call.")]
    arguments: Annotated[
        dict, Field(description="The arguments to pass to the function.")
    ]

    def __str__(self) -> str:
        lines = []
        lines.append(f"Env Type: {self.env_type}")
        lines.append(f"Func Name: {self.func_name}")
        lines.append(f"Arguments:\n{json.dumps(self.arguments, indent=2)}")
        return "\n".join(lines)


class EnvAssertion(EnvFunctionCall):
    """
    An assertion on the agent or user environment.
    """

    assert_value: Annotated[
        bool, Field(default=True, description="The value to assert on.")
    ]
    message: Annotated[
        Optional[str],
        Field(
            description="A message to display to the user if the assertion fails.",
            default=None,
        ),
    ]


class RewardType(str, Enum):
    """
    Components that can gate a task's final reward.

    The final reward is the product of every component listed in
    `EvaluationCriteria.reward_basis`. Components not listed are not
    included (they may still run for diagnostics). Default basis is
    `[DB, COMMUNICATE]`, matching the original τ-bench.

    - DB: predicted DB end state matches the target. Target is the
      result of replaying `EvaluationCriteria.actions` on a fresh env;
      any agent path producing an equivalent end state passes.
    - ENV_ASSERTION: all `env_assertions` pass on the predicted env.
    - COMMUNICATE: every `communicate_info` string appears (substring)
      in the agent's messages.
    - NL_ASSERTION: every `nl_assertions` entry is judged true by an
      LLM (experimental / WIP).
    - ACTION: every entry in `actions` is matched by an agent tool call
      (per `Action.compare_with_tool_call`). The only reward type that
      makes the action list a hard requirement — promotes it to the
      assumed-unique correct trajectory. Used in a few
      `banking_knowledge` tasks; not used in airline/retail/telecom.

    See `docs/evaluation.md`.
    """

    DB = "DB"
    ENV_ASSERTION = "ENV_ASSERTION"
    NL_ASSERTION = "NL_ASSERTION"
    ACTION = "ACTION"
    COMMUNICATE = "COMMUNICATE"


class TaskIssueStatus(str, Enum):
    """Status of a task issue."""

    OPEN = "open"
    RESOLVED = "resolved"
    WONT_FIX = "wont_fix"


class TaskIssue(BaseModel):
    """
    An issue or discussion point about a task.
    Used to track potential problems, decisions made, and their resolutions.
    """

    id: str = Field(description="Unique identifier for the issue.")
    title: str = Field(description="Short summary of the issue.")
    description: Annotated[
        Optional[str],
        Field(
            description="Detailed description of the issue or discussion point.",
            default=None,
        ),
    ]
    status: Annotated[
        TaskIssueStatus,
        Field(
            description="Current status of the issue.",
            default=TaskIssueStatus.OPEN,
        ),
    ]
    resolution: Annotated[
        Optional[str],
        Field(
            description="Explanation of how/why the issue was resolved or won't be fixed.",
            default=None,
        ),
    ]
    created_at: Annotated[
        Optional[str],
        Field(
            description="ISO date (YYYY-MM-DD) when the issue was created.",
            default=None,
        ),
    ]
    resolved_at: Annotated[
        Optional[str],
        Field(
            description="ISO date (YYYY-MM-DD) when the issue was resolved.",
            default=None,
        ),
    ]
    author_email: Annotated[
        Optional[str],
        Field(
            description="Email of the person who raised this issue.",
            default=None,
        ),
    ]
    pr_link: Annotated[
        Optional[str],
        Field(
            description="Link to the PR that fixes this issue.",
            default=None,
        ),
    ]
    simulation_file: Annotated[
        Optional[str],
        Field(
            description="Relative path to a simulation result file demonstrating the issue (e.g., 'task_issues/task_0_issue_001.json').",
            default=None,
        ),
    ]

    def __str__(self) -> str:
        lines = []
        status_icon = {"open": "🔴", "resolved": "✅", "wont_fix": "⚪"}.get(
            self.status.value, ""
        )
        lines.append(f"{status_icon} [{self.id}] {self.title}")
        if self.description:
            lines.append(f"  Description: {self.description}")
        if self.resolution:
            lines.append(f"  Resolution: {self.resolution}")
        if self.created_at:
            lines.append(f"  Created: {self.created_at}")
        if self.resolved_at:
            lines.append(f"  Resolved: {self.resolved_at}")
        if self.author_email:
            lines.append(f"  Author: {self.author_email}")
        if self.pr_link:
            lines.append(f"  PR: {self.pr_link}")
        if self.simulation_file:
            lines.append(f"  Simulation: {self.simulation_file}")
        return "\n".join(lines)


class EvaluationCriteria(BaseModel):
    """
    Evaluation criteria for a task. Sent to the evaluator.

    `reward_basis` controls which fields gate the reward; other
    populated fields run as diagnostics only. In particular, `actions`
    is one reference trajectory used to derive the target DB end state
    — not a per-call requirement on the agent unless `RewardType.ACTION`
    is in `reward_basis`. See `docs/evaluation.md`.
    """

    actions: Annotated[
        Optional[list[Action]],
        Field(
            description=(
                "One reference trajectory that solves the task. Replayed "
                "on a fresh env by `EnvironmentEvaluator` to derive the "
                "target DB hash. The agent may take any path producing "
                "an equivalent end state — these specific calls are only "
                "required when `RewardType.ACTION` is in `reward_basis`."
            ),
            default=None,
        ),
    ]

    env_assertions: Annotated[
        Optional[list[EnvAssertion]],
        Field(
            description=(
                "Assertions on the predicted environment. Gates the "
                "reward only when `RewardType.ENV_ASSERTION` is in "
                "`reward_basis`."
            ),
            default=None,
        ),
    ]

    communicate_info: Annotated[  # TODO: Deprecate this
        Optional[list[str]],
        Field(
            description=(
                "Strings the agent must say to the user (substring "
                "match). Gates the reward only when "
                "`RewardType.COMMUNICATE` is in `reward_basis`."
            ),
            default=None,
        ),
    ]

    nl_assertions: Annotated[
        Optional[list[str]],
        Field(
            description=(
                "Natural-language assertions judged by an LLM. Gates the "
                "reward only when `RewardType.NL_ASSERTION` is in "
                "`reward_basis` (experimental / WIP)."
            ),
            default=None,
        ),
    ]

    reward_basis: Annotated[
        list[RewardType],
        Field(
            description=(
                "Components that gate the final reward (their per-component "
                "rewards are multiplied). Default `[DB, COMMUNICATE]` "
                "matches the original τ-bench."
            ),
            default_factory=lambda: [RewardType.DB, RewardType.COMMUNICATE],
        ),
    ]

    def __str__(self) -> str:
        lines = []
        if self.actions is not None:
            lines.append("Actions:")
            lines.extend(
                [textwrap.indent(str(action), "\t") for action in self.actions]
            )
        if self.env_assertions is not None:
            lines.append("Env Assertions:")
            lines.extend(
                [
                    textwrap.indent(str(assertion), "\t")
                    for assertion in self.env_assertions
                ]
            )
        if self.communicate_info is not None:
            lines.append("Communicate Info:")
            lines.extend(
                [textwrap.indent(info, "\t") for info in self.communicate_info]
            )
        if self.nl_assertions is not None:
            lines.append("NL Assertions:")
            lines.extend(
                [textwrap.indent(assertion, "\t") for assertion in self.nl_assertions]
            )
        return "\n".join(lines)

    def info(self) -> dict:
        num_agent_actions = (
            len([action for action in self.actions if action.requestor == "assistant"])
            if self.actions is not None
            else 0
        )
        num_user_actions = (
            len([action for action in self.actions if action.requestor == "user"])
            if self.actions is not None
            else 0
        )
        num_env_assertions = (
            len(self.env_assertions) if self.env_assertions is not None else 0
        )
        num_nl_assertions = (
            len(self.nl_assertions) if self.nl_assertions is not None else 0
        )
        return {
            "num_agent_actions": num_agent_actions,
            "num_user_actions": num_user_actions,
            "num_env_assertions": num_env_assertions,
            "num_nl_assertions": num_nl_assertions,
        }


class InitializationData(BaseModel):
    """
    Updates default data for the agent and the user.
    """

    agent_data: Annotated[
        Optional[dict],
        Field(description="Agent env update data.", default=None),
    ]
    user_data: Annotated[
        Optional[dict],
        Field(description="User env update data.", default=None),
    ]


class InitialState(BaseModel):
    """
    Initial state of the task.
    This will be used to set the initial state of the environment and of the orchestrator.
    """

    initialization_data: Annotated[
        Optional[InitializationData],
        Field(description="Initial env update data.", default=None),
    ]
    initialization_actions: Annotated[
        Optional[list[EnvFunctionCall]],
        Field(
            description="Initial actions to be taken on the environment.", default=None
        ),
    ]
    message_history: Annotated[
        Optional[list[Message]],
        Field(
            default=None,
            description="Messages that have already been exchanged between the user, the agent and the environment. This will be used to set the initial state of the environment and of the orchestrator. Last messages must be from the user or the agent.",
        ),
    ]

    def __str__(self) -> str:
        lines = []
        if self.initialization_data is not None:
            lines.append("Initialization Data:")
            lines.extend(
                [
                    textwrap.indent(
                        self.initialization_data.model_dump_json(indent=2), "\t"
                    )
                ]
            )
        if self.initialization_actions is not None:
            lines.append("Initialization Actions:")
            lines.extend(
                [
                    textwrap.indent(str(action), "\t")
                    for action in self.initialization_actions
                ]
            )
        if self.message_history is not None:
            lines.append("Message History:")
            lines.extend(
                [
                    textwrap.indent(str(message), "\t")
                    for message in self.message_history
                ]
            )
        return "\n".join(lines)


class Task(BaseModel):
    """
    A task for a particular domain. This will be sent to the user simulator, the environment and the evaluator.
    """

    id: str = Field(description="The unique identifier for the task.")
    description: Annotated[
        Optional[Description],
        Field(
            description="Description of the task. This can be sent to the evaluator.",
            default=None,
        ),
    ]
    user_scenario: Annotated[
        UserScenario,
        Field(
            description="User scenario. This information will be sent to the user simulator."
        ),
    ]
    ticket: Annotated[
        Optional[str],
        Field(
            description="Task in ticket format for solo agent solving.",
            default=None,
        ),
    ]
    initial_state: Annotated[
        Optional[InitialState],
        Field(
            description="Initial state of the task. This will be used to set the initial state of the environment and of the orchestrator.",
            default=None,
        ),
    ]
    evaluation_criteria: Annotated[
        Optional[EvaluationCriteria],
        Field(
            description="Evaluation criteria for the task. This will be sent to the evaluator.",
            default=None,
        ),
    ]
    issues: Annotated[
        Optional[list[TaskIssue]],
        Field(
            description="List of issues, discussions, or notes about this task.",
            default=None,
        ),
    ]
    required_documents: Annotated[
        Optional[list[str]],
        Field(
            description="List of document titles required to solve the task (knowledge domain).",
            default=None,
        ),
    ]
    user_tools: Annotated[
        Optional[list[str]],
        Field(
            description="List of user tool names available to the user simulator for this task. "
            "If None, all domain user tools are available (backward compatible). "
            "If empty list, no user tools are available.",
            default=None,
        ),
    ]
    agent_opener: Annotated[
        Optional[str],
        Field(
            description="Deterministic text of the agent's scripted first message. "
            "Overrides the run-level greeting when set. In voice runs it seeds "
            "the conversation with silence audio; otherwise it is the first "
            "assistant text message. None preserves the default greeting.",
            default=None,
        ),
    ]

    def __str__(self) -> str:
        lines = []
        lines.append(f"ID: {self.id}")
        if self.description is not None:
            lines.append("Description:")
            lines.append(textwrap.indent(str(self.description), "\t"))
        lines.append("User Scenario:")
        lines.append(textwrap.indent(str(self.user_scenario), "\t"))
        if self.initial_state is not None:
            lines.append("Initial State:")
            lines.append(textwrap.indent(str(self.initial_state), "\t"))
        if self.evaluation_criteria is not None:
            lines.append("Evaluation Criteria:")
            lines.append(textwrap.indent(str(self.evaluation_criteria), "\t"))
        if self.issues is not None and len(self.issues) > 0:
            lines.append("Issues:")
            lines.extend([textwrap.indent(str(issue), "\t") for issue in self.issues])
        return "\n".join(lines)


def make_task_id() -> str:
    """
    Make a task id.
    """
    return str(uuid.uuid4())


def make_task(
    user_instructions: str,
    eval_criteria: EvaluationCriteria,
    initialization_data: Optional[InitializationData] = None,
    initialization_actions: Optional[list[EnvFunctionCall]] = None,
    message_history: Optional[list[Message]] = None,
) -> Task:
    """
    Make a task from a user instruction, an evaluation criteria and a message history.
    """

    user_scenario = UserScenario(instructions=user_instructions)
    evaluation_criteria = eval_criteria
    initial_state = None
    if message_history is not None:
        # Patch to consider empty list of tool calls as None.
        for message in message_history:
            if (
                message.role == "assistant"
                and isinstance(message.tool_calls, list)
                and len(message.tool_calls) == 0
            ):
                message.tool_calls = None

        initial_state = InitialState(
            initialization_data=initialization_data,
            initialization_actions=initialization_actions,
            message_history=message_history,
        )
    return Task(
        id=make_task_id(),
        user_scenario=user_scenario,
        evaluation_criteria=evaluation_criteria,
        initial_state=initial_state,
    )
