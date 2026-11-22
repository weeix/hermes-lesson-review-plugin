"""lesson-review has no agent-side tools or hooks. The backend is dashboard/plugin_api.py and the
desktop half is desktop/plugin.js. This module exists so Hermes' registration step (plugin
doctor, validate's capability probe) has a register() to call; it contributes nothing.
"""


def register(ctx) -> None:  # noqa: ARG001 - nothing to register on the agent side
    return None
