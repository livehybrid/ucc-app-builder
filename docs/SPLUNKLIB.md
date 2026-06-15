# Splunk Python SDK (splunklib) Reference

> Embedded documentation for AI Assistant context - enabling Python code generation for Splunk inputs.

## Overview

The Splunk Python SDK provides these key modules:
- `splunklib.modularinput` - Building modular inputs
- `splunktaucclib` - UCC-specific REST handlers
- `solnlib` - Utilities for checkpointing, credentials, logging

---

## Modular Input Structure

### Directory Layout
```
package/
├── bin/
│   ├── my_input.py           # Main input script
│   └── import_declare_test.py # Import helper
├── lib/
│   ├── splunklib/            # SDK (auto-included)
│   └── requirements.txt
└── default/
    └── inputs.conf
```

### Script Lifecycle
1. `--scheme` - Returns XML schema for Splunk to understand input parameters
2. `--validate-arguments` - Validates user configuration
3. (no args) - Executes and streams events

---

## Core Classes

### Script (Base Class)
```python
from splunklib.modularinput import Script, Scheme, Argument, Event

class MyInput(Script):
    def get_scheme(self):
        """Define input parameters."""
        scheme = Scheme("My Input")
        scheme.description = "Collects data from API"
        scheme.use_external_validation = True
        scheme.use_single_instance = False
        
        scheme.add_argument(Argument(
            name="api_url",
            title="API URL",
            description="The API endpoint to poll",
            required_on_create=True,
            data_type=Argument.data_type_string
        ))
        
        scheme.add_argument(Argument(
            name="api_key",
            title="API Key",
            required_on_create=True,
            data_type=Argument.data_type_string
        ))
        
        return scheme

    def validate_input(self, definition):
        """Validate user input before saving."""
        api_url = definition.parameters.get("api_url")
        if not api_url.startswith("https://"):
            raise ValueError("API URL must use HTTPS")

    def stream_events(self, inputs, ew):
        """Main execution - stream events to Splunk."""
        for input_name, input_item in inputs.inputs.items():
            # Your data collection logic here
            pass

if __name__ == "__main__":
    MyInput().run(sys.argv)
```

### Argument Data Types
```python
Argument.data_type_string   # Default
Argument.data_type_number
Argument.data_type_boolean
```

### Event Writing
```python
def stream_events(self, inputs, ew):
    for input_name, input_item in inputs.inputs.items():
        api_url = input_item.get("api_url")
        api_key = input_item.get("api_key")
        
        # Fetch data
        response = requests.get(api_url, headers={"Authorization": api_key})
        data = response.json()
        
        # Write events
        for record in data.get("results", []):
            event = Event()
            event.stanza = input_name
            event.data = json.dumps(record)
            event.sourcetype = "my_sourcetype"
            event.time = time.time()  # Optional: event timestamp
            ew.write_event(event)
```

---

## Common Patterns

### REST API Polling Input
```python
import sys
import json
import time
import requests
from splunklib.modularinput import Script, Scheme, Argument, Event

class RestApiInput(Script):
    def get_scheme(self):
        scheme = Scheme("REST API Input")
        scheme.description = "Polls a REST API endpoint"
        scheme.use_external_validation = True
        scheme.use_single_instance = False
        
        scheme.add_argument(Argument(
            name="endpoint",
            title="API Endpoint",
            required_on_create=True
        ))
        scheme.add_argument(Argument(
            name="interval",
            title="Polling Interval",
            required_on_create=True,
            data_type=Argument.data_type_number
        ))
        scheme.add_argument(Argument(
            name="api_key",
            title="API Key",
            required_on_create=False
        ))
        return scheme

    def validate_input(self, definition):
        interval = int(definition.parameters.get("interval", 60))
        if interval < 30:
            raise ValueError("Interval must be at least 30 seconds")

    def stream_events(self, inputs, ew):
        for input_name, input_item in inputs.inputs.items():
            endpoint = input_item.get("endpoint")
            api_key = input_item.get("api_key", "")
            
            headers = {}
            if api_key:
                headers["Authorization"] = f"Bearer {api_key}"
            
            try:
                response = requests.get(endpoint, headers=headers, timeout=30)
                response.raise_for_status()
                
                data = response.json()
                
                # Handle array or object response
                records = data if isinstance(data, list) else [data]
                
                for record in records:
                    event = Event()
                    event.stanza = input_name
                    event.data = json.dumps(record)
                    ew.write_event(event)
                    
            except Exception as e:
                ew.log("ERROR", f"Failed to fetch {endpoint}: {str(e)}")

if __name__ == "__main__":
    RestApiInput().run(sys.argv)
```

### Checkpointing (Incremental Collection)
```python
from solnlib.checkpoint import KVStoreCheckpoint

def stream_events(self, inputs, ew):
    # Initialize checkpoint
    checkpoint = KVStoreCheckpoint(
        collection_name="my_input_checkpoint",
        session_key=self._input_definition.metadata.get("session_key"),
        app=self._input_definition.metadata.get("app")
    )
    
    for input_name, input_item in inputs.inputs.items():
        # Get last checkpoint
        state = checkpoint.get(input_name) or {"last_id": 0}
        last_id = state.get("last_id", 0)
        
        # Fetch new data since last_id
        data = fetch_data_since(last_id)
        
        for record in data:
            event = Event()
            event.data = json.dumps(record)
            ew.write_event(event)
            last_id = max(last_id, record.get("id", 0))
        
        # Save checkpoint
        checkpoint.update(input_name, {"last_id": last_id})
```

### Credential Storage
```python
from solnlib.credentials import CredentialManager

def get_credentials(self, session_key, realm):
    manager = CredentialManager(
        session_key=session_key,
        app="my_app",
        owner="nobody",
        realm=realm
    )
    return manager.get_password(realm)
```

### Logging Best Practices
```python
import logging
from solnlib.log import Logs

def setup_logging(self):
    Logs.set_context(
        directory="my_app",
        namespace="my_input"
    )
    return logging.getLogger("my_input")

def stream_events(self, inputs, ew):
    logger = self.setup_logging()
    logger.info("Starting data collection")
    
    try:
        # ... collection logic
        logger.debug(f"Collected {count} events")
    except Exception as e:
        logger.error(f"Collection failed: {e}", exc_info=True)
```

---

## Error Handling

```python
def stream_events(self, inputs, ew):
    for input_name, input_item in inputs.inputs.items():
        try:
            data = self.collect_data(input_item)
            for record in data:
                event = Event()
                event.data = json.dumps(record)
                ew.write_event(event)
        except requests.exceptions.Timeout:
            ew.log("WARN", f"Request timed out for {input_name}")
        except requests.exceptions.HTTPError as e:
            ew.log("ERROR", f"HTTP error: {e.response.status_code}")
        except Exception as e:
            ew.log("ERROR", f"Unexpected error: {str(e)}")
            raise  # Re-raise to stop input
```

---

## UCC Input Helper Module

When using UCC, inputs use `inputHelperModule`:

```python
# package/bin/my_input_helper.py
import json

def validate_input(helper, definition):
    """Called when user saves input configuration."""
    api_url = definition.parameters.get("api_url", "")
    if not api_url:
        raise ValueError("API URL is required")
    return True

def stream_events(helper, inputs, ew):
    """Called to collect and stream events."""
    opt_api_url = helper.get_arg("api_url")
    opt_api_key = helper.get_arg("api_key")
    
    # Use helper for logging
    helper.log_info(f"Collecting from {opt_api_url}")
    
    # Use helper for checkpointing
    state = helper.get_check_point("last_run") or {}
    
    # Collect data
    response = helper.send_http_request(
        url=opt_api_url,
        method="GET",
        headers={"Authorization": f"Bearer {opt_api_key}"}
    )
    
    for record in response.json():
        event = helper.new_event(
            data=json.dumps(record),
            source=opt_api_url,
            sourcetype="my_sourcetype"
        )
        ew.write_event(event)
    
    # Save checkpoint
    helper.save_check_point("last_run", {"timestamp": time.time()})
```

---

## Quick Reference

| Task | Code |
|------|------|
| Get input parameter | `input_item.get("param_name")` |
| Write event | `ew.write_event(event)` |
| Log message | `ew.log("INFO", "message")` |
| Get session key | `self._input_definition.metadata.get("session_key")` |
| Parse JSON | `json.loads(data)` |
| HTTP request | `requests.get(url, headers=headers)` |
