"""Exists so Hermes' registration step (plugin doctor, validate's capability probe) has a register()
to call.
"""


def register(ctx) -> None:  # noqa: ARG001 - nothing to register on the agent side
    return None
