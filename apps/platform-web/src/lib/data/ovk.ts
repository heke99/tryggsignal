import 'server-only';
import type { TenantContext } from '@tryggsignal/tenancy';
import { tenantClient, TenantDataPlaneUnavailableError } from './client';

export interface OvkObligationOption {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly legalReference: string | null;
  readonly description: string | null;
  readonly intervalMonths: number;
}

export interface OvkProtocol {
  readonly id: string;
  readonly performedAt: string;
  readonly result: string;
  readonly documentId: string;
  readonly documentVersionId: string;
  readonly inspectorName: string | null;
  readonly inspectorOrganization: string | null;
  readonly notes: string | null;
  readonly recordedAt: string;
}

export interface OvkFinding {
  readonly id: string;
  readonly protocolId: string | null;
  readonly findingType: string;
  readonly description: string | null;
  readonly severity: string;
  readonly status: string;
  readonly dueAt: string | null;
  readonly resolvedAt: string | null;
  readonly resolutionNote: string | null;
}

export interface CaseOvkObject {
  readonly id: string;
  readonly propertyId: string | null;
  readonly buildingId: string | null;
  readonly obligationId: string;
  readonly objectReference: string | null;
  readonly ventilationSystemType: string | null;
  readonly lastPerformedAt: string | null;
  readonly nextDueAt: string | null;
  readonly status: string;
  readonly riskScore: number | null;
  readonly lastProtocolResult: string | null;
  readonly protocols: readonly OvkProtocol[];
  readonly findings: readonly OvkFinding[];
}

export interface CaseOvk {
  readonly obligations: readonly OvkObligationOption[];
  readonly objects: readonly CaseOvkObject[];
}

export async function loadCaseOvk(
  context: TenantContext,
  caseId: string,
): Promise<CaseOvk> {
  const session = await tenantClient(context);
  if (!session.authenticated) return { obligations: [], objects: [] };

  const today = new Date().toISOString().slice(0, 10);
  const obligationsResult = await session.client
    .schema('compliance')
    .from('obligations')
    .select('id, key, name, legal_reference, description')
    .eq('domain', 'OVK')
    .order('name', { ascending: true });

  const obligationRows = (obligationsResult.data ?? []) as Array<{
    id: string;
    key: string;
    name: string;
    legal_reference: string | null;
    description: string | null;
  }>;
  const obligationIds = obligationRows.map((row) => row.id);
  const rules =
    obligationIds.length === 0
      ? []
      : ((
          await session.client
            .schema('compliance')
            .from('obligation_rules')
            .select('id, obligation_id, interval_months, valid_from, valid_to')
            .in('obligation_id', obligationIds)
            .lte('valid_from', today)
            .or(`valid_to.is.null,valid_to.gt.${today}`)
            .order('valid_from', { ascending: false })
        ).data ?? []);

  const latestRuleByObligation = new Map<string, number>();
  for (const row of rules) {
    const rule = row as {
      obligation_id: string;
      interval_months: number;
    };
    if (!latestRuleByObligation.has(rule.obligation_id)) {
      latestRuleByObligation.set(rule.obligation_id, Number(rule.interval_months));
    }
  }

  const obligations: OvkObligationOption[] = obligationRows.flatMap((row) => {
    const intervalMonths = latestRuleByObligation.get(row.id);
    if (intervalMonths === undefined) return [];
    return [
      {
        id: row.id,
        key: row.key,
        name: row.name,
        legalReference: row.legal_reference,
        description: row.description,
        intervalMonths,
      },
    ];
  });

  const linksResult = await session.client
    .schema('compliance')
    .from('ovk_case_objects')
    .select('compliance_object_id')
    .eq('case_id', caseId);

  const objectIds = (linksResult.data ?? []).map((row) =>
    String((row as { compliance_object_id: string }).compliance_object_id),
  );
  if (objectIds.length === 0) return { obligations, objects: [] };

  const [objectsResult, protocolsResult, findingsResult] = await Promise.all([
    session.client
      .schema('compliance')
      .from('compliance_objects')
      .select(
        'id, property_id, building_id, obligation_id, object_reference, ventilation_system_type, last_performed_at, next_due_at, status, risk_score, last_protocol_result',
      )
      .in('id', objectIds),
    session.client
      .schema('compliance')
      .from('ovk_protocols')
      .select(
        'id, compliance_object_id, performed_at, result, protocol_document_id, protocol_document_version_id, inspector_name, inspector_organization, notes, recorded_at',
      )
      .eq('case_id', caseId)
      .order('performed_at', { ascending: false })
      .order('recorded_at', { ascending: false }),
    session.client
      .schema('compliance')
      .from('compliance_findings')
      .select(
        'id, compliance_object_id, protocol_id, finding_type, description, severity, status, due_at, resolved_at, resolution_note',
      )
      .in('compliance_object_id', objectIds)
      .order('detected_at', { ascending: false }),
  ]);

  const protocolRows = (protocolsResult.data ?? []) as Array<{
    id: string;
    compliance_object_id: string;
    performed_at: string;
    result: string;
    protocol_document_id: string;
    protocol_document_version_id: string;
    inspector_name: string | null;
    inspector_organization: string | null;
    notes: string | null;
    recorded_at: string;
  }>;
  const findingRows = (findingsResult.data ?? []) as Array<{
    id: string;
    compliance_object_id: string;
    protocol_id: string | null;
    finding_type: string;
    description: string | null;
    severity: string;
    status: string;
    due_at: string | null;
    resolved_at: string | null;
    resolution_note: string | null;
  }>;

  return {
    obligations,
    objects: ((objectsResult.data ?? []) as Array<{
      id: string;
      property_id: string | null;
      building_id: string | null;
      obligation_id: string;
      object_reference: string | null;
      ventilation_system_type: string | null;
      last_performed_at: string | null;
      next_due_at: string | null;
      status: string;
      risk_score: number | null;
      last_protocol_result: string | null;
    }>).map((object) => ({
      id: object.id,
      propertyId: object.property_id,
      buildingId: object.building_id,
      obligationId: object.obligation_id,
      objectReference: object.object_reference,
      ventilationSystemType: object.ventilation_system_type,
      lastPerformedAt: object.last_performed_at,
      nextDueAt: object.next_due_at,
      status: object.status,
      riskScore: object.risk_score === null ? null : Number(object.risk_score),
      lastProtocolResult: object.last_protocol_result,
      protocols: protocolRows
        .filter((protocol) => protocol.compliance_object_id === object.id)
        .map((protocol) => ({
          id: protocol.id,
          performedAt: protocol.performed_at,
          result: protocol.result,
          documentId: protocol.protocol_document_id,
          documentVersionId: protocol.protocol_document_version_id,
          inspectorName: protocol.inspector_name,
          inspectorOrganization: protocol.inspector_organization,
          notes: protocol.notes,
          recordedAt: protocol.recorded_at,
        })),
      findings: findingRows
        .filter((finding) => finding.compliance_object_id === object.id)
        .map((finding) => ({
          id: finding.id,
          protocolId: finding.protocol_id,
          findingType: finding.finding_type,
          description: finding.description,
          severity: finding.severity,
          status: finding.status,
          dueAt: finding.due_at,
          resolvedAt: finding.resolved_at,
          resolutionNote: finding.resolution_note,
        })),
    })),
  };
}

export interface OvkQueueRow {
  readonly objectId: string;
  readonly propertyId: string | null;
  readonly propertyDesignation: string | null;
  readonly buildingId: string | null;
  readonly buildingDesignation: string | null;
  readonly objectReference: string | null;
  readonly ventilationSystemType: string | null;
  readonly obligationName: string;
  readonly status: string;
  readonly nextDueAt: string | null;
  readonly riskScore: number | null;
  readonly openFindings: number;
  readonly linkedCaseId: string | null;
}

export interface OvkQueue {
  readonly available: boolean;
  readonly reason?: string;
  readonly rows: readonly OvkQueueRow[];
}

export async function loadOvkQueue(context: TenantContext): Promise<OvkQueue> {
  let session;
  try {
    session = await tenantClient(context);
  } catch (error) {
    if (error instanceof TenantDataPlaneUnavailableError) {
      return { available: false, reason: error.message, rows: [] };
    }
    throw error;
  }
  if (!session.authenticated) {
    return {
      available: false,
      reason: 'Ingen inloggad session på den här värden.',
      rows: [],
    };
  }

  const objectsResult = await session.client
    .schema('compliance')
    .from('compliance_objects')
    .select(
      'id, property_id, building_id, obligation_id, object_reference, ventilation_system_type, status, next_due_at, risk_score',
    )
    .order('risk_score', { ascending: false })
    .order('next_due_at', { ascending: true })
    .limit(500);

  const objects = (objectsResult.data ?? []) as Array<{
    id: string;
    property_id: string | null;
    building_id: string | null;
    obligation_id: string;
    object_reference: string | null;
    ventilation_system_type: string | null;
    status: string;
    next_due_at: string | null;
    risk_score: number | null;
  }>;
  const objectIds = objects.map((object) => object.id);
  if (objectIds.length === 0) return { available: true, rows: [] };

  const obligationIds = Array.from(new Set(objects.map((object) => object.obligation_id)));
  const propertyIds = Array.from(
    new Set(objects.map((object) => object.property_id).filter((id): id is string => id !== null)),
  );
  const buildingIds = Array.from(
    new Set(objects.map((object) => object.building_id).filter((id): id is string => id !== null)),
  );

  const [findingsResult, linksResult, obligationsResult, propertiesResult, buildingsResult] =
    await Promise.all([
      session.client
        .schema('compliance')
        .from('compliance_findings')
        .select('compliance_object_id, status')
        .in('compliance_object_id', objectIds)
        .in('status', ['OPEN', 'ACTION_REQUIRED']),
      session.client
        .schema('compliance')
        .from('ovk_case_objects')
        .select('compliance_object_id, case_id, linked_at')
        .in('compliance_object_id', objectIds)
        .order('linked_at', { ascending: false }),
      session.client
        .schema('compliance')
        .from('obligations')
        .select('id, name')
        .in('id', obligationIds),
      propertyIds.length === 0
        ? Promise.resolve({ data: [] })
        : session.client
            .schema('property')
            .from('properties')
            .select('id, designation')
            .in('id', propertyIds),
      buildingIds.length === 0
        ? Promise.resolve({ data: [] })
        : session.client
            .schema('property')
            .from('buildings')
            .select('id, building_designation, building_purpose')
            .in('id', buildingIds),
    ]);

  const openCount = new Map<string, number>();
  for (const row of findingsResult.data ?? []) {
    const id = String((row as { compliance_object_id: string }).compliance_object_id);
    openCount.set(id, (openCount.get(id) ?? 0) + 1);
  }

  const latestCase = new Map<string, string>();
  for (const row of linksResult.data ?? []) {
    const link = row as { compliance_object_id: string; case_id: string };
    if (!latestCase.has(link.compliance_object_id)) {
      latestCase.set(link.compliance_object_id, link.case_id);
    }
  }

  const obligationName = new Map(
    ((obligationsResult.data ?? []) as Array<{ id: string; name: string }>).map((row) => [
      row.id,
      row.name,
    ]),
  );
  const propertyDesignation = new Map(
    ((propertiesResult.data ?? []) as Array<{ id: string; designation: string }>).map((row) => [
      row.id,
      row.designation,
    ]),
  );
  const buildingDesignation = new Map(
    (
      (buildingsResult.data ?? []) as Array<{
        id: string;
        building_designation: string | null;
        building_purpose: string | null;
      }>
    ).map((row) => [
      row.id,
      row.building_designation ?? row.building_purpose ?? 'Byggnad',
    ]),
  );

  const priority = (status: string): number =>
    status === 'OVERDUE' ? 4 : status === 'DUE' ? 3 : status === 'UNKNOWN' ? 2 : 1;

  const rows = objects
    .filter(
      (object) =>
        ['UNKNOWN', 'DUE', 'OVERDUE'].includes(object.status) ||
        (openCount.get(object.id) ?? 0) > 0,
    )
    .map((object) => ({
      objectId: object.id,
      propertyId: object.property_id,
      propertyDesignation:
        object.property_id === null ? null : (propertyDesignation.get(object.property_id) ?? null),
      buildingId: object.building_id,
      buildingDesignation:
        object.building_id === null ? null : (buildingDesignation.get(object.building_id) ?? null),
      objectReference: object.object_reference,
      ventilationSystemType: object.ventilation_system_type,
      obligationName: obligationName.get(object.obligation_id) ?? 'OVK',
      status: object.status,
      nextDueAt: object.next_due_at,
      riskScore: object.risk_score === null ? null : Number(object.risk_score),
      openFindings: openCount.get(object.id) ?? 0,
      linkedCaseId: latestCase.get(object.id) ?? null,
    }))
    .sort((a, b) => {
      const statusDifference = priority(b.status) - priority(a.status);
      if (statusDifference !== 0) return statusDifference;
      const riskDifference = (b.riskScore ?? 0) - (a.riskScore ?? 0);
      if (riskDifference !== 0) return riskDifference;
      return (a.nextDueAt ?? '9999-12-31').localeCompare(b.nextDueAt ?? '9999-12-31');
    });

  return { available: true, rows };
}
