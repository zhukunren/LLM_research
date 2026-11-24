from dataclasses import dataclass
from typing import Literal


ModelMode = Literal["instant", "deep"]
DEFAULT_MODEL_MODE: ModelMode = "instant"


@dataclass(frozen=True)
class ModelPreset:
    label: str
    model_id: str
    reasoning_effort: str
    service_tier: str

    def selection(self) -> dict[str, str]:
        return {"model_id": self.model_id, "reasoning_effort": self.reasoning_effort}


# The provider calls Codex's Fast tier "priority" in requests.
MODEL_PRESETS = {
    "instant": ModelPreset("即时", "gpt-6.2-astra", "low", "priority"),
    "deep": ModelPreset("深度", "gpt-6.2-sol", "max", "default"),
}


def saved_model_mode(reasoning_effort: str | None) -> ModelMode:
    """Map older saved settings to a preset for the next model call."""
    return "deep" if reasoning_effort in {"xhigh", "max", "ultra"} else DEFAULT_MODEL_MODE
