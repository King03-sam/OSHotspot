#!/usr/bin/env python3
#
# OSHotspot
# Copyright 2026 OLOJEDE Samuel
#
# Licensed under the Apache License, Version 2.0

"""Thin launcher kept at the project root so existing install scripts
and shortcuts that call `python3 server.py` keep working. The actual
implementation lives in the server/ package next to this file."""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from web.server.main import main

if __name__ == "__main__":
    main()
