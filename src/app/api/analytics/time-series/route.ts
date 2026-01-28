import { getBigQueryClient } from '@/lib/bigquery';
import { NextRequest, NextResponse } from 'next/server';

export interface TimeSeriesDataPoint {
  date: string;
  high_risk_count: number;
  medium_risk_count: number;
  low_risk_count: number;
  total_anomalies: number;
}

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const days = Math.min(Number(searchParams.get('days')) || 30, 90); // Max 90 days

    const bigquery = getBigQueryClient();

    // Time-series query - Risk distribution over time
    // Since we don't have transaction dates, we'll simulate using beneficiary data
    // In production, this would use actual transaction timestamps
    // For demo, we generate synthetic time-series based on risk distribution
    const query = `
      WITH risk_counts AS (
        SELECT
          risk_level,
          COUNT(*) AS total_count
        FROM \`gfg-fot.lpg_fraud_detection.fraud_with_explanations\`
        GROUP BY risk_level
      ),
      date_series AS (
        SELECT date
        FROM UNNEST(GENERATE_DATE_ARRAY(
          DATE_SUB(CURRENT_DATE(), INTERVAL @days DAY),
          CURRENT_DATE()
        )) AS date
      )
      SELECT
        FORMAT_DATE('%Y-%m-%d', d.date) AS date,
        -- Distribute counts across days with some variance
        CAST(COALESCE((SELECT total_count FROM risk_counts WHERE risk_level = 'HIGH'), 0) / @days 
          * (0.8 + 0.4 * RAND()) AS INT64) AS high_risk_count,
        CAST(COALESCE((SELECT total_count FROM risk_counts WHERE risk_level = 'MEDIUM'), 0) / @days 
          * (0.8 + 0.4 * RAND()) AS INT64) AS medium_risk_count,
        CAST(COALESCE((SELECT total_count FROM risk_counts WHERE risk_level = 'LOW'), 0) / @days 
          * (0.8 + 0.4 * RAND()) AS INT64) AS low_risk_count
      FROM date_series d
      ORDER BY d.date ASC
    `;

    const [job] = await bigquery.createQueryJob({ query, params: { days } });
    const [rows] = await job.getQueryResults();

    const results: TimeSeriesDataPoint[] = rows.map((row) => ({
      date: row.date,
      high_risk_count: Number(row.high_risk_count),
      medium_risk_count: Number(row.medium_risk_count),
      low_risk_count: Number(row.low_risk_count),
      total_anomalies: Number(row.high_risk_count) + Number(row.medium_risk_count),
    }));

    return NextResponse.json(results);
  } catch (error) {
    console.error('Time Series Error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
    return NextResponse.json({ success: false, error: errorMessage }, { status: 500 });
  }
}
