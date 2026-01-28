import { getBigQueryClient } from '@/lib/bigquery';
import { NextRequest, NextResponse } from 'next/server';

interface ExportRow {
  beneficiary_id: string;
  risk_level: string;
  mean_squared_error: number;
  flag_high_recent_activity: boolean;
  flag_multiple_dealers: boolean;
  flag_cross_district: boolean;
  flag_high_lifetime_usage: boolean;
  residence_district?: string;
}

// GET: Export audit report as CSV data
export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const riskLevel = searchParams.get('risk_level');
    const district = searchParams.get('district');
    const format = searchParams.get('format') || 'json'; // json or csv
    const limit = Math.min(Number(searchParams.get('limit')) || 500, 5000);

    const bigquery = getBigQueryClient();

    // Build dynamic query based on filters
    let query = `
      SELECT
        f.beneficiary_id,
        f.risk_level,
        f.mean_squared_error,
        f.flag_high_recent_activity,
        f.flag_multiple_dealers,
        f.flag_cross_district,
        f.flag_high_lifetime_usage,
        b.residence_district
      FROM \`gfg-fot.lpg_fraud_detection.fraud_with_explanations\` f
      LEFT JOIN \`gfg-fot.lpg_fraud_detection.Beneficiaries\` b
      ON f.beneficiary_id = b.beneficiary_id
      WHERE 1=1
    `;

    const params: Record<string, unknown> = { limit };

    if (riskLevel && ['HIGH', 'MEDIUM', 'LOW'].includes(riskLevel.toUpperCase())) {
      query += ` AND f.risk_level = @risk_level`;
      params.risk_level = riskLevel.toUpperCase();
    }

    if (district) {
      query += ` AND b.residence_district = @district`;
      params.district = district;
    }

    query += ` ORDER BY f.mean_squared_error DESC LIMIT @limit`;

    const [job] = await bigquery.createQueryJob({ query, params });
    const [rows] = await job.getQueryResults();

    const results: ExportRow[] = rows.map((row) => ({
      beneficiary_id: row.beneficiary_id,
      risk_level: row.risk_level,
      mean_squared_error: Number(row.mean_squared_error),
      flag_high_recent_activity: Boolean(row.flag_high_recent_activity),
      flag_multiple_dealers: Boolean(row.flag_multiple_dealers),
      flag_cross_district: Boolean(row.flag_cross_district),
      flag_high_lifetime_usage: Boolean(row.flag_high_lifetime_usage),
      residence_district: row.residence_district || 'Unknown',
    }));

    if (format === 'csv') {
      // Generate CSV
      const headers = [
        'Beneficiary ID',
        'Risk Level',
        'Anomaly Score (MSE)',
        'High Recent Activity',
        'Multiple Dealers',
        'Cross District',
        'High Lifetime Usage',
        'Residence District',
      ];

      const csvRows = results.map((r) =>
        [
          r.beneficiary_id,
          r.risk_level,
          r.mean_squared_error.toFixed(6),
          r.flag_high_recent_activity ? 'Yes' : 'No',
          r.flag_multiple_dealers ? 'Yes' : 'No',
          r.flag_cross_district ? 'Yes' : 'No',
          r.flag_high_lifetime_usage ? 'Yes' : 'No',
          r.residence_district,
        ].join(',')
      );

      const csv = [headers.join(','), ...csvRows].join('\n');

      return new NextResponse(csv, {
        status: 200,
        headers: {
          'Content-Type': 'text/csv',
          'Content-Disposition': `attachment; filename="audit_report_${new Date().toISOString().split('T')[0]}.csv"`,
        },
      });
    }

    // Return JSON with metadata
    return NextResponse.json({
      success: true,
      exported_at: new Date().toISOString(),
      filters: { risk_level: riskLevel, district },
      total_records: results.length,
      data: results,
    });
  } catch (error) {
    console.error('Export Error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
    return NextResponse.json({ success: false, error: errorMessage }, { status: 500 });
  }
}
