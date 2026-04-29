const fs = require('fs');
const path = require('path');

const dashboardDir = 'grafana/dashboards';

const filesToUpdate = [
    'alerts-slo.json',
    'connection-lifecycle.json',
    'database-tables.json',
    'fleet-overview.json',
    'index-health.json',
    'io-buffers.json',
    'locks-activity.json',
    'memory-sort.json',
    'replication-wal.json',
    'vacuum-bloat.json',
    'wraparound.json'
];

const instanceVariable = {
    "name": "instance",
    "type": "query",
    "datasource": { "type": "postgres", "uid": "pgstat" },
    "query": "select display_name as __text, instance_pk::text as __value from control.instance_inventory where is_active order by display_name",
    "refresh": 1,
    "multi": true,
    "includeAll": true,
    "label": "Instance"
};

function addInstanceFilterToSql(sql) {
    let result = sql;

    // Pattern 1: (i.service_group in ($service_group) or 'All' in ($service_group) or i.service_group is null)
    const pattern1 = /\(i\.service_group in \(\$service_group\) or 'All' in \(\$service_group\) or i\.service_group is null\)/g;
    const replacement1 = "(i.instance_pk::text in ($instance) or 'All' in ($instance)) and (i.service_group in ($service_group) or 'All' in ($service_group) or i.service_group is null)";

    result = result.replace(pattern1, replacement1);

    // Pattern 2: (i.service_group in ($service_group) or 'All' in ($service_group)) WITHOUT "or i.service_group is null" after
    // Need negative lookahead to avoid matching what's already been replaced or has null check
    // Also avoid matching inside the instance_filter variable query (which uses service_group without i. prefix)
    const pattern2 = /\(i\.service_group in \(\$service_group\) or 'All' in \(\$service_group\)\)/g;

    // Only apply pattern2 if it exists and hasn't been covered by pattern1
    result = result.replace(pattern2, (match, offset, str) => {
        // Check if this is already preceded by our instance filter
        const before = str.substring(Math.max(0, offset - 60), offset);
        if (before.includes("'All' in ($instance))")) {
            return match; // Already has instance filter before it
        }
        return "(i.instance_pk::text in ($instance) or 'All' in ($instance)) and (i.service_group in ($service_group) or 'All' in ($service_group))";
    });

    return result;
}

for (const file of filesToUpdate) {
    const filePath = path.join(dashboardDir, file);
    const content = fs.readFileSync(filePath, 'utf8');
    const dashboard = JSON.parse(content);

    // 1. Add $instance variable as FIRST in templating.list
    if (!dashboard.templating) {
        dashboard.templating = { list: [] };
    }
    if (!dashboard.templating.list) {
        dashboard.templating.list = [];
    }

    // Check if instance variable already exists
    const hasInstance = dashboard.templating.list.some(v => v.name === 'instance');
    if (!hasInstance) {
        dashboard.templating.list.unshift(instanceVariable);
    }

    // 2. Update all SQL queries in panels
    function updatePanelTargets(panels) {
        if (!panels) return;
        for (const panel of panels) {
            if (panel.targets) {
                for (const target of panel.targets) {
                    if (target.rawSql) {
                        target.rawSql = addInstanceFilterToSql(target.rawSql);
                    }
                }
            }
            // Handle nested panels (rows)
            if (panel.panels) {
                updatePanelTargets(panel.panels);
            }
        }
    }

    updatePanelTargets(dashboard.panels);

    // Write back
    fs.writeFileSync(filePath, JSON.stringify(dashboard, null, 2) + '\n');
    console.log(`Updated: ${file}`);
}

console.log('\nDone! All dashboards updated.');
