"""Regional units and fixed scenario clock for telecom tools."""

from pydantic import Field, NaiveDatetime

from tau2.environment.regional import DomainRegionalSettings


class TelecomRegionalSettings(DomainRegionalSettings):
    """One call's billing units and unchanged scenario wall clock."""

    current_datetime: NaiveDatetime = Field(
        description="Fixed scenario wall clock, interpreted in time_zone without conversion."
    )
