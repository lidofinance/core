import fs from "fs";
import path from "path";

export interface TimelineEvent {
  id: string;
  title: string;
  description: string;
  timestamp: Date;
  status: "success" | "pending" | "error" | "warning";
  gasUsed?: string;
  txHash?: string;
  address?: string;
  metadata?: Record<string, string>;
}

export interface ReportData {
  title: string;
  subtitle?: string;
  network?: string;
  deployer?: string;
  events: TimelineEvent[];
  summary?: {
    totalGasUsed?: string;
    totalTransactions?: number;
    duration?: string;
  };
}

function generateSVGTimeline(events: TimelineEvent[]): string {
  const width = 1200;
  const height = Math.max(400, events.length * 100);
  const lineX = 100;
  const eventSpacing = 100;

  const statusColors = {
    success: "#10b981",
    pending: "#f59e0b",
    error: "#ef4444",
    warning: "#f59e0b",
  };

  const eventCircles = events
    .map((event, index) => {
      const y = 50 + index * eventSpacing;
      const color = statusColors[event.status];
      return `
        <circle cx="${lineX}" cy="${y}" r="10" fill="${color}" stroke="#fff" stroke-width="3"/>
        <text x="${lineX + 30}" y="${y - 20}" font-size="16" font-weight="600" fill="#1f2937">${event.title}</text>
        <text x="${lineX + 30}" y="${y}" font-size="14" fill="#6b7280">${event.description}</text>
        <text x="${lineX + 30}" y="${y + 20}" font-size="12" fill="#9ca3af">${event.timestamp.toLocaleString()}</text>
        ${event.gasUsed ? `<text x="${lineX + 30}" y="${y + 35}" font-size="11" fill="#9ca3af">Gas: ${event.gasUsed}</text>` : ""}
      `;
    })
    .join("");

  return `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="lineGradient" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" style="stop-color:#3b82f6;stop-opacity:1" />
          <stop offset="100%" style="stop-color:#10b981;stop-opacity:1" />
        </linearGradient>
      </defs>
      <line x1="${lineX}" y1="40" x2="${lineX}" y2="${height - 40}" stroke="url(#lineGradient)" stroke-width="4"/>
      ${eventCircles}
    </svg>
  `;
}

function generateHTML(data: ReportData): string {
  const svgTimeline = generateSVGTimeline(data.events);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${data.title}</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      padding: 2rem;
      color: #1f2937;
    }
    
    .container {
      max-width: 1400px;
      margin: 0 auto;
    }
    
    .header {
      background: white;
      border-radius: 1rem;
      padding: 2rem;
      margin-bottom: 2rem;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.1);
    }
    
    .header h1 {
      font-size: 2.5rem;
      font-weight: 700;
      color: #1f2937;
      margin-bottom: 0.5rem;
    }
    
    .header p {
      font-size: 1.125rem;
      color: #6b7280;
    }
    
    .info-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
      gap: 1rem;
      margin-bottom: 2rem;
    }
    
    .info-card {
      background: white;
      border-radius: 0.75rem;
      padding: 1.5rem;
      box-shadow: 0 4px 6px rgba(0, 0, 0, 0.05);
      transition: transform 0.2s, box-shadow 0.2s;
    }
    
    .info-card:hover {
      transform: translateY(-2px);
      box-shadow: 0 8px 12px rgba(0, 0, 0, 0.1);
    }
    
    .info-card-label {
      font-size: 0.875rem;
      font-weight: 600;
      color: #6b7280;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 0.5rem;
    }
    
    .info-card-value {
      font-size: 1.25rem;
      font-weight: 600;
      color: #1f2937;
      word-break: break-all;
    }
    
    .timeline-section {
      background: white;
      border-radius: 1rem;
      padding: 2rem;
      margin-bottom: 2rem;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.1);
    }
    
    .timeline-section h2 {
      font-size: 1.875rem;
      font-weight: 700;
      color: #1f2937;
      margin-bottom: 2rem;
    }
    
    .timeline-container {
      overflow-x: auto;
      padding: 1rem;
      background: #f9fafb;
      border-radius: 0.5rem;
    }
    
    .events-table {
      width: 100%;
      background: white;
      border-radius: 0.75rem;
      overflow: hidden;
      box-shadow: 0 4px 6px rgba(0, 0, 0, 0.05);
    }
    
    .events-table table {
      width: 100%;
      border-collapse: collapse;
    }
    
    .events-table thead {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
    }
    
    .events-table th {
      padding: 1rem;
      text-align: left;
      font-weight: 600;
      font-size: 0.875rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    
    .events-table td {
      padding: 1rem;
      border-bottom: 1px solid #e5e7eb;
    }
    
    .events-table tr:last-child td {
      border-bottom: none;
    }
    
    .events-table tbody tr:hover {
      background: #f9fafb;
    }
    
    .status-badge {
      display: inline-block;
      padding: 0.25rem 0.75rem;
      border-radius: 9999px;
      font-size: 0.75rem;
      font-weight: 600;
      text-transform: uppercase;
    }
    
    .status-success {
      background: #d1fae5;
      color: #065f46;
    }
    
    .status-pending {
      background: #fef3c7;
      color: #92400e;
    }
    
    .status-error {
      background: #fee2e2;
      color: #991b1b;
    }
    
    .status-warning {
      background: #fef3c7;
      color: #92400e;
    }
    
    .footer {
      text-align: center;
      color: white;
      margin-top: 2rem;
      padding: 1rem;
    }
    
    .code {
      font-family: "Monaco", "Menlo", "Ubuntu Mono", monospace;
      font-size: 0.875rem;
      background: #f3f4f6;
      padding: 0.25rem 0.5rem;
      border-radius: 0.25rem;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>${data.title}</h1>
      ${data.subtitle ? `<p>${data.subtitle}</p>` : ""}
    </div>
    
    <div class="info-grid">
      ${data.network ? `
      <div class="info-card">
        <div class="info-card-label">Network</div>
        <div class="info-card-value">${data.network}</div>
      </div>
      ` : ""}
      ${data.deployer ? `
      <div class="info-card">
        <div class="info-card-label">Deployer</div>
        <div class="info-card-value code">${data.deployer}</div>
      </div>
      ` : ""}
      ${data.summary?.totalTransactions ? `
      <div class="info-card">
        <div class="info-card-label">Total Transactions</div>
        <div class="info-card-value">${data.summary.totalTransactions}</div>
      </div>
      ` : ""}
      ${data.summary?.totalGasUsed ? `
      <div class="info-card">
        <div class="info-card-label">Total Gas Used</div>
        <div class="info-card-value">${data.summary.totalGasUsed}</div>
      </div>
      ` : ""}
      ${data.summary?.duration ? `
      <div class="info-card">
        <div class="info-card-label">Duration</div>
        <div class="info-card-value">${data.summary.duration}</div>
      </div>
      ` : ""}
    </div>
    
    <div class="timeline-section">
      <h2>Deployment Timeline</h2>
      <div class="timeline-container">
        ${svgTimeline}
      </div>
    </div>
    
    <div class="events-table">
      <table>
        <thead>
          <tr>
            <th>Status</th>
            <th>Event</th>
            <th>Description</th>
            <th>Timestamp</th>
            <th>Gas Used</th>
            <th>Details</th>
          </tr>
        </thead>
        <tbody>
          ${data.events
            .map(
              (event) => `
            <tr>
              <td><span class="status-badge status-${event.status}">${event.status}</span></td>
              <td><strong>${event.title}</strong></td>
              <td>${event.description}</td>
              <td>${event.timestamp.toLocaleString()}</td>
              <td>${event.gasUsed || "—"}</td>
              <td>
                ${event.txHash ? `<div class="code" style="font-size: 0.75rem">${event.txHash.slice(0, 10)}...${event.txHash.slice(-8)}</div>` : ""}
                ${event.address ? `<div class="code" style="font-size: 0.75rem; margin-top: 0.25rem">${event.address.slice(0, 10)}...${event.address.slice(-8)}</div>` : ""}
              </td>
            </tr>
          `,
            )
            .join("")}
        </tbody>
      </table>
    </div>
    
    <div class="footer">
      <p>Generated on ${new Date().toLocaleString()} • Lido Protocol Deployment Report</p>
    </div>
  </div>
</body>
</html>`;
}

export function generateReport(data: ReportData, outputPath: string): void {
  const html = generateHTML(data);
  const dir = path.dirname(outputPath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(outputPath, html, "utf-8");
  console.log(`✅ Report generated: ${outputPath}`);
}

export function openReport(reportPath: string): void {
  const absolutePath = path.resolve(reportPath);
  console.log(`📊 View report: file://${absolutePath}`);
}
