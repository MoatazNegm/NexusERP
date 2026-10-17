#!/bin/bash
cd /home/erp/qc; nohup python3 -I runner.py 18 ${1:-1} > run.out 2>&1 &
