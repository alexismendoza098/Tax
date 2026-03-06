
// =====================================================
// UI ENHANCEMENTS: SEARCH & AUTO-REFRESH
// =====================================================

let refreshInterval = null;

window.toggleAutoRefresh = () => {
    const chk = document.getElementById('auto-refresh-toggle');
    if (chk && chk.checked) {
        if (!refreshInterval) {
            refreshInterval = setInterval(() => {
                console.log('Auto-refreshing history...');
                loadDownloadHistory();
            }, 60000); // 1 minute
            console.log('Auto-refresh enabled');
        }
    } else {
        if (refreshInterval) {
            clearInterval(refreshInterval);
            refreshInterval = null;
            console.log('Auto-refresh disabled');
        }
    }
};

window.filterRequests = () => {
    const input = document.getElementById('requests-search');
    const filter = input.value.toLowerCase();
    const tableBody = document.getElementById('requests-table-body');
    const rows = tableBody.getElementsByTagName('tr');

    // If filter is empty, reset to default state (parents visible, children hidden)
    if (!filter) {
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            if (row.classList.contains('group-header')) {
                row.style.display = '';
            } else if (row.className.includes('group-child-')) {
                row.style.display = 'none';
            } else {
                // Standalone row
                row.style.display = '';
            }
        }
        return;
    }

    const visibleGroups = new Set();

    // First pass: Find matches and identify groups to show
    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const text = row.textContent || row.innerText;
        const matches = text.toLowerCase().indexOf(filter) > -1;
        
        if (matches) {
            row.style.display = ''; // Show matching row
            
            // If it's a child, we must show its parent
            const childClass = Array.from(row.classList).find(c => c.startsWith('group-child-'));
            if (childClass) {
                const groupId = childClass.replace('group-child-', '');
                visibleGroups.add(groupId);
            }
            // If it's a parent, we show it (already done by display='')
        } else {
            row.style.display = 'none';
        }
    }

    // Second pass: Ensure parents of matching children are visible
    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (row.classList.contains('group-header')) {
            const groupId = row.dataset.groupId;
            if (visibleGroups.has(groupId)) {
                row.style.display = '';
            }
        }
    }

    // Filter Mobile Cards if they exist
    const cards = document.querySelectorAll('.request-card');
    if (cards.length > 0) {
        cards.forEach(card => {
            if (!filter) {
                card.style.display = '';
                return;
            }
            const text = card.textContent || card.innerText;
            if (text.toLowerCase().indexOf(filter) > -1) {
                card.style.display = '';
            } else {
                card.style.display = 'none';
            }
        });
    }
};

// Hook into loadDownloadHistory to re-apply filter if needed
const originalLoadDownloadHistory = loadDownloadHistory;
loadDownloadHistory = async () => {
    await originalLoadDownloadHistory();
    // If there's an active search, re-apply it
    const searchInput = document.getElementById('requests-search');
    if (searchInput && searchInput.value) {
        filterRequests();
    }
};
