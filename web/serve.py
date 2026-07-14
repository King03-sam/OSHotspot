#!/usr/bin/env python3
#
# OSHotspot
# Copyright 2026 OLOJEDE Samuel
#
# Licensed under the Apache License, Version 2.0

"""Thin launcher for the OSHotspot web dashboard.

The actual implementation lives in the web/server/ package.  Keeping
the entry point as serve.py avoids a name clash with the server/
package directory."""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from web.server.main import main

if __name__ == "__main__":
    main()
