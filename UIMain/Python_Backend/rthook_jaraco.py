# rthook_jaraco.py  —  PyInstaller runtime hook, runs before any user code.
#
# Problem: pkg_resources.__init__ does `import jaraco.text` (and .functools,
# .context, .classes) at module level.  In a normal conda environment this
# works via a meta-path hook that pkg_resources.extern installs, redirecting
# those imports to pkg_resources._vendor.jaraco.*.  In the frozen bundle
# that hook hasn't been set up yet when pyi_rth_pkgres fires, so the import
# fails with "No module named 'jaraco.text'".
#
# Fix: manually pre-populate sys.modules with the vendored copies BEFORE
# pkg_resources is imported, so the unconditional `import jaraco.*` lines
# find the modules already registered and skip the meta-path machinery.

import sys
import types

def _alias_vendored_jaraco(vendor_parent):
    """
    Try to import jaraco sub-modules from `vendor_parent._vendor.jaraco.*`
    and register them under the bare `jaraco.*` names.
    Returns True on success.
    """
    try:
        # Import the vendored jaraco namespace
        vendored_ns = __import__(
            f"{vendor_parent}.jaraco", fromlist=["text"]
        )
    except ImportError:
        return False

    # Register the top-level 'jaraco' namespace if not already present
    if "jaraco" not in sys.modules:
        ns = types.ModuleType("jaraco")
        ns.__path__    = list(getattr(vendored_ns, "__path__", []))
        ns.__package__ = "jaraco"
        sys.modules["jaraco"] = ns

    # Alias each sub-module that pkg_resources actually imports
    for sub in ("text", "functools", "context", "classes"):
        vendor_full = f"{vendor_parent}.jaraco.{sub}"
        top_level   = f"jaraco.{sub}"
        if top_level not in sys.modules:
            try:
                mod = __import__(vendor_full, fromlist=[""])
                sys.modules[top_level] = mod
                # Also register as an attribute on the namespace
                setattr(sys.modules["jaraco"], sub, mod)
            except ImportError:
                pass  # sub-module not present in this vendor tree; skip

    return True


# Try pkg_resources vendor first (most common in conda miniforge),
# then setuptools vendor as fallback.
for _parent in ("pkg_resources._vendor", "setuptools._vendor"):
    if _alias_vendored_jaraco(_parent):
        break
