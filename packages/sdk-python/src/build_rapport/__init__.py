"""The Rapport SDK — Python bindings.

Mirrors the TypeScript ``build-rapport`` package: a thin client over the Rapport
API that handles auth, request serialization, optional client-side Ed25519
signing, and Mechanism 1 identity headers.
"""

from .errors import RapportError
from .rapport import Rapport

__all__ = ["Rapport", "RapportError"]
__version__ = "0.1.0"
