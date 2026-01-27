import { getBigQueryClient, BeneficiaryDetail, generateReasonsFromFlags } from '@/lib/bigquery';
import { generateGeminiExplanation, flagsToReasonCodes, getStaticExplanations, DEFAULT_LANGUAGE, type SupportedLanguage } from '@/lib/gemini';
import { NextRequest, NextResponse } from 'next/server';

// Allowlist for valid language codes
const ALLOWED_LANGUAGES: readonly SupportedLanguage[] = ['en', 'hi', 'hinglish'] as const;

function validateLanguage(lang: string | null): SupportedLanguage {
  if (lang && ALLOWED_LANGUAGES.includes(lang as SupportedLanguage)) {
    return lang as SupportedLanguage;
  }
  return DEFAULT_LANGUAGE;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ beneficiary_id: string }> }
) {
  try {
    const { beneficiary_id } = await params;
    const searchParams = request.nextUrl.searchParams;
    const language = validateLanguage(searchParams.get('lang'));

    if (!beneficiary_id) {
      return NextResponse.json(
        { success: false, error: 'beneficiary_id is required' },
        { status: 400 }
      );
    }

    const bigquery = getBigQueryClient();

    // Get all data from fraud_with_explanations (single source of truth)
    const query = `
      SELECT
        beneficiary_id,
        risk_level,
        mean_squared_error,
        flag_high_recent_activity,
        flag_multiple_dealers,
        flag_cross_district,
        flag_high_lifetime_usage
      FROM \`gfg-fot.lpg_fraud_detection.fraud_with_explanations\`
      WHERE beneficiary_id = @beneficiary_id
    `;

    const [job] = await bigquery.createQueryJob({ 
      query, 
      params: { beneficiary_id } 
    });
    const [rows] = await job.getQueryResults();

    if (rows.length === 0) {
      return NextResponse.json(
        { success: false, error: 'Beneficiary not found' },
        { status: 404 }
      );
    }

    const row = rows[0];
    
    // Extract flags (deterministic - from BigQuery)
    const flags = {
      high_recent_activity: Boolean(row.flag_high_recent_activity),
      multiple_dealers: Boolean(row.flag_multiple_dealers),
      cross_district: Boolean(row.flag_cross_district),
      high_lifetime_usage: Boolean(row.flag_high_lifetime_usage),
    };

    // Generate deterministic reasons from flags
    const reasons = generateReasonsFromFlags(flags);

    // Generate AI-polished explanation via Gemini (optional, with fallback)
    const reasonCodes = flagsToReasonCodes({
      flag_high_recent_activity: flags.high_recent_activity,
      flag_multiple_dealers: flags.multiple_dealers,
      flag_cross_district: flags.cross_district,
      flag_high_lifetime_usage: flags.high_lifetime_usage,
    });
    
    // Wrap Gemini call in try-catch to handle failures/timeouts gracefully
    let geminiExplanation: string;
    try {
      geminiExplanation = await generateGeminiExplanation(
        row.risk_level,
        reasonCodes,
        language
      );
    } catch (geminiError) {
      // Log error but don't crash the request - use deterministic fallback
      console.error('Gemini explanation failed:', geminiError instanceof Error ? geminiError.message : 'Unknown error');
      // Fallback: use static explanations derived from reasonCodes
      geminiExplanation = getStaticExplanations(reasonCodes, language).join(' ');
    }

    const result: BeneficiaryDetail = {
      beneficiary_id: row.beneficiary_id,
      risk_level: row.risk_level || 'UNKNOWN',
      mean_squared_error: Number(row.mean_squared_error) || 0,
      flags,
      reasons,
      gemini_explanation: geminiExplanation,
    };

    return NextResponse.json(result);
  } catch (error) {
    console.error('Beneficiary Detail Error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
    return NextResponse.json({ success: false, error: errorMessage }, { status: 500 });
  }
}
