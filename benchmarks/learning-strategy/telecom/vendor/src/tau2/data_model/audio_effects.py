# Copyright Sierra
"""Audio effects data models (config and result classes)."""

from typing import Literal, Optional

from pydantic import BaseModel, Field, computed_field

from tau2.voice_config import (
    BURST_NOISE_EVENTS_PER_MINUTE,
    BURST_SNR_RANGE_DB,
    ENABLE_BACKGROUND_NOISE,
    ENABLE_BURST_NOISE,
    ENABLE_DYNAMIC_MUFFLING,
    ENABLE_FRAME_DROPS,
    ENABLE_OUT_OF_TURN_SPEECH,
    ENABLE_VOCAL_TICS_DURING_SPEECH,
    FRAME_DROP_BURST_DURATION_MS,
    FRAME_DROP_COUNT,
    FRAME_DROP_DURATION_MS,
    FRAME_DROP_RATE,
    MIN_WORDS_FOR_VOCAL_TICS,
    MUFFLE_CUTOFF_FREQ,
    MUFFLE_PROBABILITY,
    MUFFLE_SEGMENT_COUNT,
    MUFFLE_SEGMENT_DURATION_MS,
    MUFFLE_TRANSITION_MS,
    NOISE_SNR_DB,
    NOISE_SNR_DRIFT_DB,
    NOISE_VARIATION_SPEED,
    NON_DIRECTED_PHRASES,
    OUT_OF_TURN_SPEECH_EVENTS_PER_MINUTE,
    VOCAL_TICS,
)

UserSpeechInsertType = Literal["vocal_tic", "non_directed_phrase"]


class UserSpeechInsert(BaseModel):
    """A user speech insert (vocal tic or non-directed phrase)."""

    text: str = Field(description="Text to synthesize")
    type: UserSpeechInsertType = Field(description="Type of speech insert")

    @property
    def is_muffled(self) -> bool:
        return self.type == "non_directed_phrase"


class ChannelEffectsConfig(BaseModel):
    """Channel/transmission effects (frame drops via Gilbert-Elliott model)."""

    enable_frame_drops: bool = Field(
        default=ENABLE_FRAME_DROPS,
        description="Enable frame drop simulation",
    )
    frame_drop_rate: float = Field(
        default=FRAME_DROP_RATE,
        ge=0.0,
        lt=0.2,
        description="Target average loss rate (0.0 to 0.2). E.g., 0.02 for 2% loss.",
    )
    frame_drop_burst_duration_ms: float = Field(
        default=FRAME_DROP_BURST_DURATION_MS,
        gt=0.0,
        description="Average burst duration in ms. Longer = more consecutive drops.",
    )
    frame_drop_count: int = Field(
        default=FRAME_DROP_COUNT,
        ge=1,
        description="Number of drops per trigger (batch mode only)",
    )
    frame_drop_duration_ms: int = Field(
        default=FRAME_DROP_DURATION_MS,
        ge=1,
        description="Duration of each individual frame drop in ms",
    )


class ChannelEffectsResult(BaseModel):
    """Result of transmission/network channel effects."""

    frame_drops_enabled: bool = Field(default=False)
    frame_drop_ms: int = Field(default=0)


class SourceEffectsConfig(BaseModel):
    """Source/acoustic environment effects (background noise, burst noise)."""

    # Background noise SNR settings
    enable_background_noise: bool = Field(default=ENABLE_BACKGROUND_NOISE)
    noise_snr_db: float = Field(default=NOISE_SNR_DB)
    noise_snr_drift_db: float = Field(default=NOISE_SNR_DRIFT_DB)
    noise_variation_speed: float = Field(default=NOISE_VARIATION_SPEED)

    # Burst noise SNR settings
    enable_burst_noise: bool = Field(default=ENABLE_BURST_NOISE)
    burst_noise_events_per_minute: float = Field(
        default=BURST_NOISE_EVENTS_PER_MINUTE, ge=0.0
    )
    burst_snr_range_db: tuple[float, float] = Field(default=BURST_SNR_RANGE_DB)


class SourceEffectsResult(BaseModel):
    """Result of acoustic environment/source effects."""

    burst_noise_file: Optional[str] = Field(default=None)
    speech_insert: Optional[UserSpeechInsert] = Field(default=None)


class SpeechEffectsConfig(BaseModel):
    """Speech effects applied to the speaker's voice."""

    enable_dynamic_muffling: bool = Field(default=ENABLE_DYNAMIC_MUFFLING)
    muffle_probability: float = Field(default=MUFFLE_PROBABILITY, ge=0.0, le=1.0)
    muffle_segment_count: int = Field(default=MUFFLE_SEGMENT_COUNT, ge=1)
    muffle_segment_duration_ms: int = Field(default=MUFFLE_SEGMENT_DURATION_MS, ge=1)
    muffle_cutoff_freq: float = Field(default=MUFFLE_CUTOFF_FREQ, ge=100.0)
    muffle_transition_ms: int = Field(default=MUFFLE_TRANSITION_MS, ge=0)

    enable_vocal_tics: bool = Field(default=ENABLE_VOCAL_TICS_DURING_SPEECH)
    vocal_tics: list[UserSpeechInsert] = Field(
        default_factory=lambda: [
            UserSpeechInsert(text=t, type="vocal_tic") for t in VOCAL_TICS
        ]
    )
    min_words_for_vocal_tics: int = Field(default=MIN_WORDS_FOR_VOCAL_TICS, ge=1)

    enable_non_directed_phrases: bool = Field(default=ENABLE_OUT_OF_TURN_SPEECH)
    non_directed_phrases: list[UserSpeechInsert] = Field(
        default_factory=lambda: [
            UserSpeechInsert(text=t, type="non_directed_phrase")
            for t in NON_DIRECTED_PHRASES
        ]
    )

    speech_insert_events_per_minute: float = Field(
        default=OUT_OF_TURN_SPEECH_EVENTS_PER_MINUTE, ge=0.0
    )

    def get_out_of_turn_speech_inserts(self) -> list[UserSpeechInsert]:
        """Get combined list of out-of-turn speech inserts."""
        items: list[UserSpeechInsert] = []
        if self.enable_vocal_tics:
            items.extend(self.vocal_tics)
        if self.enable_non_directed_phrases:
            items.extend(self.non_directed_phrases)
        return items


class SpeechEffectsResult(BaseModel):
    """Result of speech effects applied to the speaker's voice."""

    dynamic_muffling_enabled: bool = Field(default=False)
    speech_insert: Optional[UserSpeechInsert] = Field(default=None)


# ---------------------------------------------------------------------------
# Effect timeline models (for structured effect tracking in trajectories)
# ---------------------------------------------------------------------------

EffectType = Literal[
    "background_noise",
    "burst_noise",
    "out_of_turn_speech",
    "telephony",
    "frame_drop",
    "spell_out",
]


class SpellOutDetection(BaseModel):
    """One detected spell-out of a tracked entity field in a user-sim
    utterance (the ``spell_out`` effect event's params contract).

    Produced by a domain-owned detector on the exact pre-synthesis
    utterance text, providing deterministic caller-effort observations."""

    field: str = Field(description="The tracked entity field whose value was spelled.")
    letters_spoken: int = Field(
        ge=2,
        description="Number of spell tokens rendered (single characters or "
        "digit words), summed over the utterance's runs for this field.",
    )
    spelled_text: str = Field(
        description="The matched spell-out run(s) verbatim, ' / '-joined, "
        "faltered restart attempts included, in utterance order."
    )
    restarts: int = Field(
        default=0,
        ge=0,
        description="Number of FALTERED attempts before the complete run: "
        "runs in the same utterance whose skeleton is one edit away from a "
        "prefix of this field's value skeleton (the spell_correction "
        "complication's construct). Their tokens count in letters_spoken — "
        "restarts are re-delivery effort.",
    )


class EffectEvent(BaseModel):
    """A single audio effect occurrence with precise timing.

    Params dict holds effect-specific metadata, e.g.:
      burst_noise:        {"file": "car_horn.wav", "snr_db": 5.0}
      out_of_turn_speech: {"type": "vocal_tic", "text": "[cough]"}
      frame_drop:         {"duration_ms": 60}
      background_noise:   {"noise_file": "busy_street.wav", "avg_snr_db": 15.0}
      telephony:          {"input_rate": 16000, "output_rate": 8000, "encoding": "ulaw"}
    """

    effect_type: EffectType = Field(description="Type of audio effect")
    start_ms: int = Field(description="Start time relative to audio stream origin (ms)")
    end_ms: Optional[int] = Field(
        default=None,
        description="End time (ms). None while still active.",
    )
    participant: Literal["user", "agent"] = Field(
        description="Which participant this effect applies to"
    )
    params: Optional[dict] = Field(
        default=None,
        description="Effect-specific metadata",
    )

    @computed_field
    @property
    def duration_ms(self) -> Optional[int]:
        """Duration in ms, computed from start/end."""
        if self.end_ms is not None:
            return self.end_ms - self.start_ms
        return None


class EffectTimeline(BaseModel):
    """Ordered list of effect events for a simulation.

    Provides helpers to open/close events and query by type.
    """

    events: list[EffectEvent] = Field(default_factory=list)

    def open_event(
        self,
        effect_type: EffectType,
        start_ms: int,
        participant: Literal["user", "agent"],
        params: Optional[dict] = None,
    ) -> EffectEvent:
        """Record the start of a new effect. Call close_event() when it ends."""
        event = EffectEvent(
            effect_type=effect_type,
            start_ms=start_ms,
            participant=participant,
            params=params,
        )
        self.events.append(event)
        return event

    def close_event(
        self,
        effect_type: EffectType,
        end_ms: int,
        participant: Literal["user", "agent"] = "user",
    ) -> Optional[EffectEvent]:
        """Close the most recent open event of the given type.

        Returns the closed event, or None if no open event was found.
        """
        for event in reversed(self.events):
            if (
                event.effect_type == effect_type
                and event.end_ms is None
                and event.participant == participant
            ):
                event.end_ms = end_ms
                return event
        return None

    def close_all_open(self, end_ms: int) -> None:
        """Close all open events (e.g., at end of simulation)."""
        for event in self.events:
            if event.end_ms is None:
                event.end_ms = end_ms

    def get_events_by_type(self, effect_type: EffectType) -> list[EffectEvent]:
        """Return all events of a given type."""
        return [e for e in self.events if e.effect_type == effect_type]

    def has_open_event(
        self,
        effect_type: EffectType,
        participant: Literal["user", "agent"] = "user",
    ) -> bool:
        """Check if there's an open (unclosed) event of the given type."""
        return any(
            e.effect_type == effect_type
            and e.end_ms is None
            and e.participant == participant
            for e in self.events
        )
