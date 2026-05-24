---
description: Record a comprehensive video demonstration of Order Management tab permutations
---

# Order Management Video Recording Workflow

This workflow instructs the agent to use the browser subagent to record a comprehensive demonstration covering all permutations of the Order Management tabs.

**Context:**
The application is running locally at `http://localhost:4005`. Navigate to the "Order Management" view via the sidebar.

**Task Execution Steps for the Browser Subagent:**
Please execute the following scenarios sequentially, ensuring smooth transitions and a 2-second pause after every major action (like submitting a form or changing tabs) so the viewer can follow along.

### Scenario 1: Logging a Standard Customer Order
1. Ensure you are on the **"New Acquisition"** tab.
2. Enter `PO-EXT-001` in the PO Reference Number field.
3. Select an existing customer (e.g., `Acme Corp`) from the Customer Entity Name dropdown.
4. Set the Payment SLA to `30` days.
5. In the Transaction Line Items section, add a line item: Description `Industrial Pump`, Quantity `5`, Unit Price `1200`.
6. Click **"Commit Acquisition"** and wait for the success message to appear.

### Scenario 2: Logging an Internal Stock Order
1. Click the **"Order for Stock"** tab. Observe that the form automatically resets and prepopulates the customer as `Internal Stock` with a generated stock reference number.
2. In the Transaction Line Items section, modify the default line item: Description `Spare Bearings`, Quantity `50`, Unit Price `45`.
3. Click **"Commit Acquisition"** and wait for the success message to appear.

### Scenario 3: Modifying a Logged Order (Edit Window)
1. Click the **"Logged Orders"** tab to view the registry of uncommitted operational records.
2. Locate the first order in the list (this should be the `Internal Stock` order you just created) and click the **"Resume Record"** button next to it.
3. Observe that the application routes you back to the "New Acquisition" tab, prepopulated with the order data, and displays an "EDITABLE" banner showing the remaining time in the 1-hour lifecycle window.
4. Modify the quantity of the line item from `50` to `60`.
5. Click **"Save Modification"** and wait for the success message to appear.

### Finalization
- After completing Scenario 3, navigate back to the **"Logged Orders"** tab to show the updated list.
- Wait exactly 5 seconds to ensure the final state is captured.
- Stop the recording, compile the session into an `MP4` file format, and provide the file in the final response. Do not modify any underlying codebase during this execution.
