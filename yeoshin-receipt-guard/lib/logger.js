/**
 * Structured JSON Logger for Yeoshin Receipt Guard
 *
 * Purpose: Provide structured logging for QA monitoring
 * Output: JSON logs to browser console (easily parsed and analyzed)
 * Storage: Session logs cached in chrome.storage.local
 *
 * Usage:
 *   const logger = new ExtensionLogger('content'); // or 'background' or 'options'
 *   logger.info('operation_name', 'Human readable message', { key: 'value' });
 */

class ExtensionLogger {
  constructor(context) {
    // context: 'content', 'background', 'options'
    this.context = context;
    this.requestId = this.generateRequestId();
    this.sessionStartTime = Date.now();
  }

  /**
   * Generate unique request ID for tracing across extension
   * Format: req_xxxxxxxx (8 char hex)
   */
  generateRequestId() {
    const hex = Math.random().toString(16).substring(2, 10);
    return `req_${hex}`;
  }

  /**
   * Core logging method - formats and outputs structured JSON
   */
  log(level, operation, message, data = {}) {
    const logEntry = {
      timestamp: new Date().toISOString(),
      level: level.toUpperCase(), // DEBUG, INFO, WARNING, ERROR
      context: this.context,
      request_id: this.requestId,
      operation: operation,
      message: message,
      data: { ...data }
    };

    // Output to console (for immediate inspection)
    this.outputToConsole(logEntry);

    // Store in session cache (for later analysis)
    this.storeLog(logEntry);

    // Also store raw log string for debugging
    this.attachDebugInfo(logEntry);
  }

  /**
   * Output log to console with level-based coloring
   */
  outputToConsole(logEntry) {
    const levelColors = {
      'DEBUG': '#888888',
      'INFO': '#00AA00',
      'WARNING': '#FFAA00',
      'ERROR': '#FF0000'
    };

    const color = levelColors[logEntry.level] || '#000000';
    const style = `color: ${color}; font-weight: bold;`;

    // Console output for developer inspection
    console.log(`%c[${logEntry.level}]%c ${logEntry.message}`, style, 'color: inherit');
    console.log(logEntry); // Full JSON object
  }

  /**
   * Store log in chrome.storage.local for session analysis
   */
  storeLog(logEntry) {
    chrome.storage.local.get({ sessionLogs: [] }, (result) => {
      try {
        const logs = result.sessionLogs || [];
        logs.push(logEntry);

        // Keep only last 500 logs (limit storage)
        if (logs.length > 500) {
          logs = logs.slice(-500);
        }

        chrome.storage.local.set({ sessionLogs: logs });
      } catch (e) {
        console.error('Logger storage error:', e);
      }
    });
  }

  /**
   * Attach debugging metadata
   */
  attachDebugInfo(logEntry) {
    logEntry.sessionDuration_ms = Date.now() - this.sessionStartTime;
    logEntry.url = typeof window !== 'undefined' ? window.location.href : 'N/A';
  }

  /**
   * Public logging methods
   */

  debug(operation, message, data = {}) {
    this.log('DEBUG', operation, message, data);
  }

  info(operation, message, data = {}) {
    this.log('INFO', operation, message, data);
  }

  warning(operation, message, data = {}) {
    this.log('WARNING', operation, message, data);
  }

  error(operation, message, data = {}) {
    this.log('ERROR', operation, message, data);
  }

  /**
   * Measure execution time of an async operation
   * Usage:
   *   const timer = logger.startTimer();
   *   await someAsync();
   *   logger.logTiming('operation_name', timer, { extra: 'data' });
   */
  startTimer() {
    return Date.now();
  }

  logTiming(operation, startTime, data = {}) {
    const duration = Date.now() - startTime;
    this.info(operation, `Completed in ${duration}ms`, {
      duration_ms: duration,
      ...data
    });
  }

  /**
   * Set custom request ID (useful for tracing related operations)
   */
  setRequestId(id) {
    this.requestId = id;
  }

  /**
   * Get all stored session logs
   */
  static getSessionLogs(callback) {
    chrome.storage.local.get({ sessionLogs: [] }, (result) => {
      callback(result.sessionLogs || []);
    });
  }

  /**
   * Clear all stored session logs
   */
  static clearSessionLogs(callback) {
    chrome.storage.local.set({ sessionLogs: [] }, callback);
  }

  /**
   * Export logs as JSON file
   */
  static exportLogs(filename = null) {
    this.getSessionLogs((logs) => {
      const data = JSON.stringify(logs, null, 2);
      const blob = new Blob([data], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename || `yrg-logs-${new Date().toISOString()}.json`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    });
  }

  /**
   * Filter logs by level
   */
  static filterLogsByLevel(level, callback) {
    this.getSessionLogs((logs) => {
      const filtered = logs.filter(log => log.level === level.toUpperCase());
      callback(filtered);
    });
  }

  /**
   * Filter logs by operation
   */
  static filterLogsByOperation(operation, callback) {
    this.getSessionLogs((logs) => {
      const filtered = logs.filter(log => log.operation === operation);
      callback(filtered);
    });
  }

  /**
   * Filter logs by request ID (trace entire flow)
   */
  static filterLogsByRequestId(requestId, callback) {
    this.getSessionLogs((logs) => {
      const filtered = logs.filter(log => log.request_id === requestId);
      callback(filtered);
    });
  }

  /**
   * Get statistics about session logs
   */
  static getStatistics(callback) {
    this.getSessionLogs((logs) => {
      const stats = {
        total_logs: logs.length,
        by_level: {
          DEBUG: 0,
          INFO: 0,
          WARNING: 0,
          ERROR: 0
        },
        by_context: {},
        by_operation: {},
        errors: []
      };

      logs.forEach(log => {
        // Count by level
        if (stats.by_level[log.level] !== undefined) {
          stats.by_level[log.level]++;
        }

        // Count by context
        stats.by_context[log.context] = (stats.by_context[log.context] || 0) + 1;

        // Count by operation
        stats.by_operation[log.operation] = (stats.by_operation[log.operation] || 0) + 1;

        // Collect errors
        if (log.level === 'ERROR') {
          stats.errors.push({
            timestamp: log.timestamp,
            operation: log.operation,
            message: log.message,
            data: log.data
          });
        }
      });

      callback(stats);
    });
  }
}

// Make available globally
window.ExtensionLogger = ExtensionLogger;

// Also export for use in modules if needed
if (typeof module !== 'undefined' && module.exports) {
  module.exports = ExtensionLogger;
}
