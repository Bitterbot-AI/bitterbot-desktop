"""Instance-local regional units shared by domain environments."""

import re
from decimal import Decimal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, ConfigDict, Field, field_validator
from pydantic.json_schema import GenerateJsonSchema

from tau2.environment.tool import Tool

REGIONAL_RUNTIME_VERSION = "regional-tools-v1"


class DomainRegionalSettings(BaseModel):
    """Recorded regional units; database amounts have already been scaled."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    country_code: str = Field(pattern=r"^[A-Z]{2}$", description="ISO country code.")
    currency_code: str = Field(pattern=r"^[A-Z]{3}$", description="ISO currency code.")
    currency_scale: Decimal = Field(
        gt=0,
        allow_inf_nan=False,
        description="Fixed benchmark multiplier for canonical tool fees, not database prices.",
    )
    time_zone: str = Field(
        description="IANA timezone interpreting unchanged scenario clocks."
    )

    @field_validator("time_zone")
    @classmethod
    def valid_time_zone(cls, value: str) -> str:
        """Reject unknown timezone labels before an environment is constructed."""
        try:
            ZoneInfo(value)
        except (ValueError, ZoneInfoNotFoundError) as exc:
            raise ValueError("Unknown regional timezone") from exc
        return value

    def scale_fee(self, amount: int) -> float:
        """Scale a fixed canonical fee once using the map's currency rule."""
        return float(Decimal(amount) * self.currency_scale)

    def format_money(self, amount: int | float) -> str:
        """Label a value already expressed in the selected currency."""
        return f"{self.currency_code} {amount:.2f}"


def _regional_schema_model(
    model: type[BaseModel], settings: DomainRegionalSettings
) -> type[BaseModel]:
    """Adapt complete nested schema descriptions without mutating domain models."""

    class RegionalSchema(GenerateJsonSchema):
        def generate(self, schema, mode="validation"):
            result = super().generate(schema, mode)

            def visit(value):
                if isinstance(value, dict):
                    for key, child in value.items():
                        if key == "description" and isinstance(child, str):
                            value[key] = re.sub(
                                r"\b(?:USD|dollars?|EST)\b",
                                lambda match: settings.time_zone
                                if match[0] == "EST"
                                else settings.currency_code,
                                child,
                            )
                        else:
                            visit(child)
                elif isinstance(value, list):
                    for child in value:
                        visit(child)

            visit(result)
            return result

    class RegionalModel(model):
        model_config = ConfigDict(title=model.model_config.get("title", model.__name__))

        @classmethod
        def model_json_schema(cls, *args, **kwargs):
            kwargs["schema_generator"] = RegionalSchema
            return super().model_json_schema(*args, **kwargs)

    return RegionalModel


def describe_regional_tool(tool: Tool, settings: DomainRegionalSettings) -> Tool:
    """Add resolved units to this freshly constructed tool, without global edits."""
    context = (
        f"Monetary amounts use {settings.currency_code}. "
        f"Scenario dates and times use {settings.time_zone}; "
        "existing field names and identifier formats are unchanged."
    )
    tool.long_desc = "\n\n".join(part for part in (tool.long_desc, context) if part)
    tool.params = _regional_schema_model(tool.params, settings)
    tool.returns = _regional_schema_model(tool.returns, settings)
    return tool
