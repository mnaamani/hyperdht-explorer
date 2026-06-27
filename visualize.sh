#!/usr/bin/env bash
set -u

# Regenerate the visualizations so the pages stay current.
npx bare timeline.js 
npx bare map.js      
npx bare ring.js     
npx bare summary.js  
npx bare topo.js     
