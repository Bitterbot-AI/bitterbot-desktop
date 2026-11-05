import json
from copy import deepcopy
from typing import Literal, Optional

from pydantic import BaseModel, Field, field_validator, model_validator

from tau2.data_model.audio import (
    AudioFormat,
    audio_bytes_to_string,
    audio_string_to_bytes,
)
from tau2.data_model.audio_effects import (
    ChannelEffectsResult,
    SourceEffectsResult,
    SpeechEffectsResult,
)
from tau2.utils.utils import get_now

SystemRole = Literal["system"]
UserRole = Literal["user"]
AssistantRole = Literal["assistant"]
ToolRole = Literal["tool"]
ToolRequestor = UserRole | AssistantRole
ParticipantRole = UserRole | AssistantRole


class SystemMessage(BaseModel):
    """
    A system message.
    """

    role: SystemRole = Field(description="The role of the message sender.")
    content: Optional[str] = Field(
        description="The content of the message.", default=None
    )
    turn_idx: Optional[int] = Field(
        description="The index of the turn in the conversation.", default=None
    )
    timestamp: Optional[str] = Field(
        description="The timestamp of the message.", default_factory=get_now
    )

    def __str__(self) -> str:
        lines = [
            "SystemMessage",
        ]
        if self.turn_idx is not None:
            lines.append(f"turn_idx: {self.turn_idx}")
        if self.timestamp is not None:
            lines.append(f"timestamp: {self.timestamp}")
        if self.content is not None:
            lines.append(f"content: {self.content}")
        return "\n".join(lines)

    def __eq__(self, other: object) -> bool:
        if not isinstance(other, SystemMessage):
            return False
        return self.role == other.role and self.content == other.content


class ToolCall(BaseModel):
    """
    A tool call.
    """

    id: str = Field(default="", description="The unique identifier for the tool call.")
    name: str = Field(description="The name of the tool.")
    arguments: dict = Field(description="The arguments of the tool.")
    requestor: ToolRequestor = Field(
        "assistant",
        description="The requestor of the tool call.",
    )

    def __str__(self) -> str:
        lines = [f"ToolCall (from {self.requestor})"]
        if self.id:
            lines.append(f"id: {self.id}")
        lines.append(f"name: {self.name}")
        lines.append(f"arguments:\n{json.dumps(self.arguments, indent=2)}")
        return "\n".join(lines)

    @classmethod
    def from_string(cls, string: str) -> "ToolCall":
        """
        Inverse of above __str__ method.
        Parses a string representation back into a ToolCall object.
        Format expected:
            ToolCall (from <requestor>)
            id: <id>
            name: <name>
            arguments:
            {json}
        """
        lines = string.strip().split("\n")

        # Parse first line for requestor
        first_line = lines[0]
        if "from assistant" in first_line:
            requestor = "assistant"
        elif "from user" in first_line:
            requestor = "user"
        else:
            requestor = "assistant"  # default

        # Parse remaining lines
        tool_id = ""
        name = ""
        arguments = {}

        i = 1
        while i < len(lines):
            line = lines[i]

            if line.startswith("id: "):
                tool_id = line[4:].strip()
            elif line.startswith("name: "):
                name = line[6:].strip()
            elif line.startswith("arguments:"):
                # Collect all remaining lines as JSON
                json_lines = lines[i + 1 :]
                json_str = "\n".join(json_lines)
                arguments = json.loads(json_str)
                break

            i += 1

        return cls(
            id=tool_id,
            name=name,
            arguments=arguments,
            requestor=requestor,
        )

    def __eq__(self, other: object) -> bool:
        if not isinstance(other, ToolCall):
            return False
        return (
            self.id == other.id
            and self.name == other.name
            and self.arguments == other.arguments
            and self.requestor == other.requestor
        )


class TurnTakingAction(BaseModel):
    """
    A turn-taking action.

    Contains the action type and optional timing metadata for performance analysis.
    """

    action: str = Field(description="The action to take in the turn-taking.")
    info: Optional[str] = Field(
        description="Additional information about the action.", default=None
    )

    # --- Timing/cost metadata for performance analysis ---
    interrupt_check_seconds: Optional[float] = Field(
        description="Wall clock time (seconds) for the interrupt decision LLM call.",
        default=None,
    )
    interrupt_check_cost: Optional[float] = Field(
        description="Cost (USD) for the interrupt decision LLM call.",
        default=None,
    )
    interrupt_check_usage: Optional[dict] = Field(
        description="Token usage for the interrupt decision LLM call.",
        default=None,
    )
    backchannel_check_seconds: Optional[float] = Field(
        description="Wall clock time (seconds) for the backchannel decision LLM call.",
        default=None,
    )
    backchannel_check_cost: Optional[float] = Field(
        description="Cost (USD) for the backchannel decision LLM call.",
        default=None,
    )
    backchannel_check_usage: Optional[dict] = Field(
        description="Token usage for the backchannel decision LLM call.",
        default=None,
    )
    llm_generation_seconds: Optional[float] = Field(
        description="Wall clock time (seconds) for the user LLM generation call.",
        default=None,
    )
    tts_synthesis_seconds: Optional[float] = Field(
        description="Wall clock time (seconds) for the TTS synthesis call.",
        default=None,
    )


class ParticipantMessageBase(BaseModel):
    """
    A message from a participant in the conversation.
    Supports text and binary (audio) content.
    """

    role: str = Field(description="The role of the message sender.")

    # --- Core content ---
    content: Optional[str] = Field(
        description="The content of the message. Text content or base64-encoded audio bytes.",
        default=None,
    )
    tool_calls: Optional[list[ToolCall]] = Field(
        description="The tool calls made in the message.", default=None
    )
    is_audio: bool = Field(
        default=False,
        description="Whether this message represents audio (base64-encoded bytes) instead of text.",
    )

    # --- Metadata ---
    turn_idx: Optional[int] = None
    timestamp: Optional[str] = Field(default_factory=get_now)
    cost: Optional[float] = None
    usage: Optional[dict] = None
    raw_data: Optional[dict] = None
    generation_time_seconds: Optional[float] = Field(
        description="Wall clock time (seconds) for LLM generation of this message.",
        default=None,
    )

    # --- Audio data ---
    audio_format: Optional[AudioFormat] = Field(
        description="The format of the audio data.", default=None
    )
    audio_content: Optional[str] = Field(
        description="The base64-encoded audio content of the message.",
        default=None,
        exclude=True,  # Exclude from serialization due to large size
    )
    audio_path: Optional[str] = Field(
        description="Path to audio file containing the spoken message.", default=None
    )  # TODO: This should be into content if content is a path.
    audio_script_gold: Optional[str] = Field(
        description="The script of the audio content of the message.", default=None
    )
    # Audio effects by source (3-tier taxonomy)
    speech_effects: Optional[SpeechEffectsResult] = Field(
        description="Speech effects applied to the speaker's voice.",
        default=None,
    )
    source_effects: Optional[SourceEffectsResult] = Field(
        description="Acoustic environment/source effects.",
        default=None,
    )
    channel_effects: Optional[ChannelEffectsResult] = Field(
        description="Transmission/network channel effects.",
        default=None,
    )

    # --- Turn taking related fields ---
    turn_taking_action: Optional[TurnTakingAction] = Field(
        description="The action taken in the turn-taking.",
        default=None,
    )

    # --- Streaming fields ---
    utterance_ids: Optional[list[str]] = Field(
        description="utterances ids for the message.", default=None
    )
    chunk_id: Optional[int] = None
    is_final_chunk: bool = True
    source: Optional[str] = None  # e.g., "mic", "tts", "text", etc.
    contains_speech: bool = True  # TODO: Added to help with speech detection. There needs to be a better way to do this.

    # ------------------------
    # 🔒 Validation & Encoding
    # ------------------------

    @field_validator("content", mode="before")
    @classmethod
    def _encode_bytes_to_base64(cls, value):
        """Encode bytes to base64 string if needed."""
        if isinstance(value, (bytes, bytearray)):
            return audio_bytes_to_string(value)
        return value

    # ------------------------
    # 🧠 Helpers
    # ------------------------

    def validate(self):  # NOTE: It would be better to do this in the Pydantic model
        """Ensure that the message has either text/audio content or tool calls."""
        if not (self.has_content() or self.is_tool_call()):
            raise ValueError(
                f"{self.__class__.__name__} must have either content or tool_calls. Got {self}"
            )

    def has_content(self) -> bool:
        """Check if message has any non-empty content (text or audio)."""
        has_text = self.content is not None and bool(self.content.strip())
        has_audio = self.audio_content is not None and bool(self.audio_content.strip())
        return has_text or has_audio

    def has_text_content(self) -> bool:
        """
        Backward compatible: check if message has text content specifically.
        """
        if self.content is None:
            return False
        return bool(self.content.strip())

    def has_audio_content(self) -> bool:
        """Check if message has audio content."""
        if not self.is_audio:
            return False
        if self.audio_content is None:
            return False
        return bool(self.audio_content.strip())

    def is_tool_call(self) -> bool:
        """
        Check if the message is a tool call.
        """
        return self.tool_calls is not None

    def get_audio_bytes(self) -> Optional[bytes]:
        """
        Decode and return audio content as bytes.
        Returns None if audio_content is empty.

        Note: This method checks audio_content directly, not is_audio flag.
        This allows extracting audio from messages that store audio for
        playback/recording but use is_audio=False for text-mode semantics
        (e.g., DiscreteTimeAudioNativeAgent).
        """
        if not self.audio_content:
            return None
        return audio_string_to_bytes(self.audio_content)

    @classmethod
    def merge_chunks(
        cls, chunks: list["ParticipantMessageBase"]
    ) -> "ParticipantMessageBase":
        """Merge a list of streaming message chunks into a single message.

        Delegates to :func:`merge_message_chunks`. See that function for
        full documentation.
        """
        return merge_message_chunks(cls, chunks)

    # ------------------------
    # 🧩 String repr & equality
    # ------------------------

    def __str__(self) -> str:
        lines = [f"{self.role.capitalize()}Message"]
        if self.is_audio:
            # For audio, content is base64-encoded string
            audio_len = (
                len(audio_string_to_bytes(self.audio_content))
                if self.audio_content
                else 0
            )
            lines.append(
                f"(AUDIO base64_len={len(self.audio_content or '')}, decoded_len={audio_len})"
            )
        if self.has_text_content():
            lines.append(f"content: {self.content}")
        if self.is_tool_call():
            lines.append("ToolCalls:")
            lines.extend([str(tc) for tc in self.tool_calls])
        if self.chunk_id is not None:
            lines.append(f"chunk_id: {self.chunk_id}")
        lines.append(f"is_final_chunk: {self.is_final_chunk}")
        return "\n".join(lines)

    def __eq__(self, other: object) -> bool:
        if not isinstance(other, ParticipantMessageBase):
            return False
        return (
            self.role == other.role
            and self.content == other.content
            and self.is_audio == other.is_audio
            and self.tool_calls == other.tool_calls
            and self.audio_content == other.audio_content
        )


class AssistantMessage(ParticipantMessageBase):
    """
    A message from the assistant.

    Use the factory classmethods for explicit construction:
      - ``AssistantMessage.text(...)`` for standard text / half-duplex messages
      - ``AssistantMessage.voice(...)`` for audio / full-duplex streaming messages

    The regular constructor still works and accepts all fields.
    """

    role: AssistantRole = Field(description="The role of the message sender.")

    @classmethod
    def text(
        cls,
        content: str,
        *,
        tool_calls: Optional[list[ToolCall]] = None,
        cost: Optional[float] = None,
        usage: Optional[dict] = None,
        raw_data: Optional[dict] = None,
        generation_time_seconds: Optional[float] = None,
    ) -> "AssistantMessage":
        """Create a text-only assistant message (half-duplex / standard mode)."""
        return cls(
            role="assistant",
            content=content,
            tool_calls=tool_calls,
            cost=cost,
            usage=usage,
            raw_data=raw_data,
            generation_time_seconds=generation_time_seconds,
        )

    @classmethod
    def voice(
        cls,
        *,
        content: Optional[str] = None,
        is_audio: bool = True,
        audio_content: Optional[str] = None,
        audio_format: Optional[AudioFormat] = None,
        audio_path: Optional[str] = None,
        audio_script_gold: Optional[str] = None,
        speech_effects: Optional[SpeechEffectsResult] = None,
        source_effects: Optional[SourceEffectsResult] = None,
        channel_effects: Optional[ChannelEffectsResult] = None,
        tool_calls: Optional[list[ToolCall]] = None,
        cost: Optional[float] = None,
        usage: Optional[dict] = None,
        raw_data: Optional[dict] = None,
        generation_time_seconds: Optional[float] = None,
        chunk_id: Optional[int] = None,
        is_final_chunk: bool = True,
        utterance_ids: Optional[list[str]] = None,
        contains_speech: bool = True,
        source: Optional[str] = None,
        turn_taking_action: Optional[TurnTakingAction] = None,
    ) -> "AssistantMessage":
        """Create a voice/streaming assistant message (full-duplex / audio mode)."""
        return cls(
            role="assistant",
            content=content,
            tool_calls=tool_calls,
            is_audio=is_audio,
            audio_content=audio_content,
            audio_format=audio_format,
            audio_path=audio_path,
            audio_script_gold=audio_script_gold,
            speech_effects=speech_effects,
            source_effects=source_effects,
            channel_effects=channel_effects,
            cost=cost,
            usage=usage,
            raw_data=raw_data,
            generation_time_seconds=generation_time_seconds,
            chunk_id=chunk_id,
            is_final_chunk=is_final_chunk,
            utterance_ids=utterance_ids,
            contains_speech=contains_speech,
            source=source,
            turn_taking_action=turn_taking_action,
        )


class UserMessage(ParticipantMessageBase):
    """
    A message from the user.

    Use the factory classmethods for explicit construction:
      - ``UserMessage.text(...)`` for standard text / half-duplex messages
      - ``UserMessage.voice(...)`` for audio / full-duplex streaming messages

    The regular constructor still works and accepts all fields.
    """

    role: UserRole = Field(description="The role of the message sender.")

    @classmethod
    def text(
        cls,
        content: str,
        *,
        tool_calls: Optional[list[ToolCall]] = None,
        cost: Optional[float] = None,
        usage: Optional[dict] = None,
        raw_data: Optional[dict] = None,
        generation_time_seconds: Optional[float] = None,
    ) -> "UserMessage":
        """Create a text-only user message (half-duplex / standard mode)."""
        return cls(
            role="user",
            content=content,
            tool_calls=tool_calls,
            cost=cost,
            usage=usage,
            raw_data=raw_data,
            generation_time_seconds=generation_time_seconds,
        )

    @classmethod
    def voice(
        cls,
        *,
        content: Optional[str] = None,
        is_audio: bool = True,
        audio_content: Optional[str] = None,
        audio_format: Optional[AudioFormat] = None,
        audio_path: Optional[str] = None,
        audio_script_gold: Optional[str] = None,
        speech_effects: Optional[SpeechEffectsResult] = None,
        source_effects: Optional[SourceEffectsResult] = None,
        channel_effects: Optional[ChannelEffectsResult] = None,
        tool_calls: Optional[list[ToolCall]] = None,
        cost: Optional[float] = None,
        usage: Optional[dict] = None,
        raw_data: Optional[dict] = None,
        generation_time_seconds: Optional[float] = None,
        chunk_id: Optional[int] = None,
        is_final_chunk: bool = True,
        utterance_ids: Optional[list[str]] = None,
        contains_speech: bool = True,
        source: Optional[str] = None,
        turn_taking_action: Optional[TurnTakingAction] = None,
    ) -> "UserMessage":
        """Create a voice/streaming user message (full-duplex / audio mode)."""
        return cls(
            role="user",
            content=content,
            tool_calls=tool_calls,
            is_audio=is_audio,
            audio_content=audio_content,
            audio_format=audio_format,
            audio_path=audio_path,
            audio_script_gold=audio_script_gold,
            speech_effects=speech_effects,
            source_effects=source_effects,
            channel_effects=channel_effects,
            cost=cost,
            usage=usage,
            raw_data=raw_data,
            generation_time_seconds=generation_time_seconds,
            chunk_id=chunk_id,
            is_final_chunk=is_final_chunk,
            utterance_ids=utterance_ids,
            contains_speech=contains_speech,
            source=source,
            turn_taking_action=turn_taking_action,
        )


class ToolMessage(BaseModel):
    """
    A message from the tool.
    """

    id: str = Field(description="The unique identifier for the tool call.")
    role: ToolRole = Field(description="The role of the message sender.")
    content: Optional[str] = Field(description="The output of the tool.", default=None)
    requestor: Literal["user", "assistant"] = Field(
        "assistant",
        description="The requestor of the tool call.",
    )
    error: bool = Field(description="Whether the tool call failed.", default=False)
    execution_status: Literal["executed", "rejected"] = Field(
        default="executed",
        description="Whether the environment executed the call, or the orchestrator "
        "rejected it before execution. Rejected calls have no replay side effects.",
    )
    turn_idx: Optional[int] = Field(
        description="The index of the turn in the conversation.", default=None
    )
    timestamp: Optional[str] = Field(
        description="The timestamp of the message.", default_factory=get_now
    )

    @model_validator(mode="after")
    def validate_rejection(self) -> "ToolMessage":
        """A call rejected before execution must report a tool error."""
        if self.execution_status == "rejected" and not self.error:
            raise ValueError("A rejected tool call must have error=True")
        return self

    def __str__(self) -> str:
        lines = [f"ToolMessage (responding to {self.requestor})"]
        if self.turn_idx is not None:
            lines.append(f"turn_idx: {self.turn_idx}")
        if self.timestamp is not None:
            lines.append(f"timestamp: {self.timestamp}")
        if self.content is not None:
            lines.append(f"content: {self.content}")
        if self.error:
            lines.append("Error")
        return "\n".join(lines)

    def __eq__(self, other: object) -> bool:
        if type(other) is not type(self):
            return False
        return (
            self.id == other.id
            and self.role == other.role
            and self.content == other.content
            and self.requestor == other.requestor
            and self.error == other.error
            and self.execution_status == other.execution_status
        )


class MultiToolMessage(BaseModel):
    """
    Encapsulates multiple tool messages.
    """

    role: ToolRole = Field(description="The role of the message sender.")
    tool_messages: list[ToolMessage] = Field(description="The tool messages.")


APICompatibleMessage = SystemMessage | AssistantMessage | UserMessage | ToolMessage
Message = (
    SystemMessage | AssistantMessage | UserMessage | ToolMessage | MultiToolMessage
)
EnvironmentMessage = ToolMessage | MultiToolMessage
ValidInputMessage = UserMessage | AssistantMessage | EnvironmentMessage


# ---------------------------------------------------------------------------
# Type guard helpers
# ---------------------------------------------------------------------------


def is_voice_message(msg: ParticipantMessageBase) -> bool:
    """Check if a message carries voice/audio data.

    Returns True if the message has ``is_audio=True`` **or** has
    ``audio_content`` set.  This covers both explicit audio messages and
    discrete-time audio-native agents that set ``is_audio=False`` but
    attach ``audio_content`` for time-alignment purposes.
    """
    return msg.is_audio or msg.audio_content is not None


def is_streaming_chunk(msg: ParticipantMessageBase) -> bool:
    """Check if a message is a streaming chunk (part of a full-duplex conversation)."""
    return msg.chunk_id is not None


class Tick(BaseModel):
    """
    Represents all events that occurred in a single simulation tick.

    In full-duplex mode, both agent and user can generate chunks simultaneously,
    and tool calls may be executed. This dataclass groups all these events together,
    preserving the temporal relationship between concurrent actions.

    Attributes:
        tick_id: The sequential identifier for this tick.
        timestamp: When this tick occurred.
        agent_chunk: The final chunk generated by the agent (if any).
        user_chunk: The final chunk generated by the user (if any).
        agent_tool_calls: Tool calls made by the agent during this tick.
        user_tool_calls: Tool calls made by the user during this tick.
        agent_tool_results: Tool results from agent's tool calls during this tick.
        user_tool_results: Tool results from user's tool calls during this tick.
        user_transcript: Proportional user input transcription (filled by post-processing).
    """

    tick_id: int
    timestamp: str
    agent_chunk: Optional[AssistantMessage] = None
    user_chunk: Optional[UserMessage] = None
    agent_tool_calls: list[ToolCall] = Field(default_factory=list)
    user_tool_calls: list[ToolCall] = Field(default_factory=list)
    agent_tool_results: list[ToolMessage] = Field(default_factory=list)
    user_tool_results: list[ToolMessage] = Field(default_factory=list)
    user_transcript: Optional[str] = None

    # --- Timing metadata ---
    tick_duration_seconds: Optional[float] = Field(
        description="Configured simulation tick duration in seconds (constant, e.g., 0.05 = 50ms).",
        default=None,
    )
    wall_clock_duration_seconds: Optional[float] = Field(
        description="Actual wall clock time this tick took in seconds.",
        default=None,
    )

    def get_all_messages(self) -> list[Message]:
        """Return the shared full-row view: agent first, then caller."""
        from tau2.utils.transcript.views import tick_messages

        return tick_messages(self)


# ---------------------------------------------------------------------------
# Standalone merge utility (extracted from ParticipantMessageBase)
# ---------------------------------------------------------------------------


def merge_message_chunks(
    message_class: type[ParticipantMessageBase],
    chunks: list[ParticipantMessageBase],
) -> ParticipantMessageBase:
    """Merge a list of streaming message chunks into a single message.

    Handles text concatenation (with utterance-id-aware spacing), audio byte
    merging (base64 decode/concat/re-encode), and turn-taking action
    aggregation. Intended for voice/streaming workflows.

    Args:
        message_class: The concrete message class to instantiate (e.g.
            AssistantMessage, UserMessage). Passed automatically when called
            via the ``ParticipantMessageBase.merge_chunks`` classmethod.
        chunks: List of message chunks to merge. All must share the same role
            and ``is_audio`` flag. None may contain tool calls.

    Returns:
        A single merged message of type ``message_class``.

    Raises:
        ValueError: If chunks is empty, types are mixed, roles differ,
            tool calls are present, or audio formats are inconsistent.
    """
    if not chunks:
        raise ValueError("Cannot merge empty list of chunks.")
    if not all(isinstance(chunk, message_class) for chunk in chunks):
        raise ValueError("All chunks must be of the same type.")

    first_role = chunks[0].role
    if not all(chunk.role == first_role for chunk in chunks):
        raise ValueError(
            f"All chunks must be from the same role. Found roles: "
            f"{set(chunk.role for chunk in chunks)}"
        )

    if any(chunk.is_tool_call() for chunk in chunks):
        raise ValueError("Cannot merge chunks that contain tool calls.")

    first_is_audio = chunks[0].is_audio
    if not all(chunk.is_audio == first_is_audio for chunk in chunks):
        raise ValueError(
            "All chunks must be either audio or non-audio. "
            f"Found mixed types: {[chunk.is_audio for chunk in chunks]}"
        )

    # --- Merge audio content (if any chunks carry it) ---
    has_audio = any(chunk.audio_content for chunk in chunks)
    merged_audio_content: Optional[str] = None
    merged_script_gold: Optional[str] = None
    first_format: Optional[AudioFormat] = None

    if has_audio:
        formats = [chunk.audio_format for chunk in chunks if chunk.audio_content]
        if formats and not all(f == formats[0] for f in formats):
            raise ValueError(
                f"All audio chunks must have the same audio format. "
                f"Found formats: {set(str(f) for f in formats)}"
            )
        first_format = formats[0] if formats else None

        merged_audio_bytes = b"".join(
            (audio_string_to_bytes(chunk.audio_content) if chunk.audio_content else b"")
            for chunk in chunks
        )
        merged_audio_content = audio_bytes_to_string(merged_audio_bytes)

        # Gold markup is shared by runtime, evaluators and transcript readers.
        from tau2.utils.transcript.audio_text import merge_audio_script_gold

        script_golds = [chunk.audio_script_gold for chunk in chunks]
        merged_script_gold = merge_audio_script_gold(script_golds)

    # --- Merge text content (utterance-id-aware spacing) ---
    content_parts: list[str] = []
    prev_utterance_ids: set[str] = set()

    for chunk in chunks:
        chunk_content = chunk.content or ""
        if not chunk_content:
            continue

        chunk_utterance_ids = set(chunk.utterance_ids or [])

        if (
            content_parts
            and chunk_utterance_ids
            and prev_utterance_ids
            and chunk_utterance_ids.isdisjoint(prev_utterance_ids)
        ):
            content_parts.append(" ")

        content_parts.append(chunk_content)
        prev_utterance_ids = chunk_utterance_ids

    merged_content = "".join(content_parts)

    # --- Merge utterance_ids (order-preserving dedup) ---
    merged_utterance_ids: list[str] = []
    seen_utterance_ids: set[str] = set()
    for chunk in chunks:
        for uid in chunk.utterance_ids or []:
            if uid not in seen_utterance_ids:
                seen_utterance_ids.add(uid)
                merged_utterance_ids.append(uid)

    # --- Merge turn-taking actions ---
    turn_action_parts: list[str] = []
    for chunk in chunks:
        if chunk.turn_taking_action:
            action = chunk.turn_taking_action.action
            info = chunk.turn_taking_action.info
            if info:
                turn_action_parts.append(f"{action}: {info}")
            else:
                turn_action_parts.append(action)

    merged_turn_action_info = (
        "\n".join(turn_action_parts)
        if turn_action_parts
        else "No turn-taking actions in merged chunks."
    )

    return message_class(
        role=first_role,
        content=merged_content,
        is_audio=first_is_audio,
        audio_content=merged_audio_content,
        audio_format=deepcopy(first_format) if first_format else None,
        audio_script_gold=merged_script_gold if merged_script_gold else None,
        utterance_ids=merged_utterance_ids if merged_utterance_ids else None,
        tool_calls=None,
        turn_taking_action=TurnTakingAction(action="N/A", info=merged_turn_action_info),
    )
