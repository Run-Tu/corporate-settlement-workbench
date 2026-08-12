export type Direction = "in" | "out";

export interface Branch {
  branchId: string;
  branchName: string;
  region: string;
  analysisPeriod: string;
}

export interface Customer {
  customerId: string;
  customerName: string;
  industry: string;
  branchId: string;
  branchName: string;
  managerName: string;
  customerTier: string;
  tags: string[];
}

export interface Account {
  accountId: string;
  customerId: string;
  accountName: string;
  accountType: string;
  balance: number;
  avgBalance90d: number;
}

export interface Product {
  productId: string;
  productName: string;
  productType: string;
  fitScenarios: string[];
  requiredMaterials: string;
  valuePoint: string;
}

export interface ProductUsage {
  usageId: string;
  customerId: string;
  productId: string;
  signed: boolean;
  activated: boolean;
  txnCount90d: number;
  txnAmount90d: number;
  lastUsedDate: string;
  usageStatus: string;
}

export type VerificationStatus = "verified" | "pending" | "suspicious";

export interface Transaction {
  txnId: string;
  customerId: string;
  accountId: string;
  txnDate: string;
  direction: Direction;
  amount: number;
  balanceAfter: number;
  counterpartyName: string;
  counterpartyType: string;
  summary: string;
  channel: string;
  verificationStatus?: VerificationStatus;
}

export interface CustomerRelation {
  relationId: string;
  customerId: string;
  relationType: "branch" | "controller" | "executive" | "affiliate";
  relatedName: string;
  roleName: string;
  ownershipRatio: number;
  relationStrength: number;
}

export interface BalanceSnapshot {
  snapshotId: string;
  customerId: string;
  snapshotDate: string;
  balance: number;
  balanceType: string;
}

export interface IndustryProfile {
  profileId: string;
  customerId: string;
  industryName: string;
  industryChain: string;
  upstreamTags: string[];
  downstreamTags: string[];
  businessPattern: string;
}

export interface ScenarioRule {
  ruleId: string;
  scenarioName: string;
  ruleName: string;
  evidenceType: string;
  weight: number;
}

export interface ProcessStep {
  processStepId: string;
  customerId: string;
  stepOrder: number;
  stepName: string;
  ownerRole: string;
  requiredMaterial: string;
  estimatedDays: number;
}

export interface ValueParameter {
  valueParameterId: string;
  customerId: string;
  depositRetentionRate: number;
  txnCaptureRate: number;
  opportunityScore: number;
  similarCustomerCount: number;
}

export interface OntologyGraphNode {
  nodeId: string;
  customerId: string;
  stepId: OntologyStep["id"];
  nodeType: string;
  nodeName: string;
  nodeBadge: string;
  nodeDetail: string;
  details: string[];
  positionX: number;
  positionY: number;
  importance: number;
}

export interface OntologyGraphEdge {
  edgeId: string;
  customerId: string;
  stepId: OntologyStep["id"];
  sourceNodeId: string;
  targetNodeId: string;
  relationName: string;
  relationDetail: string;
  weight: number;
}

export interface SettlementDataset {
  branch: Branch;
  customers: Customer[];
  accounts: Account[];
  products: Product[];
  productUsage: ProductUsage[];
  transactions: Transaction[];
  customerRelations: CustomerRelation[];
  balanceSnapshots: BalanceSnapshot[];
  industryProfiles: IndustryProfile[];
  scenarioRules: ScenarioRule[];
  processSteps: ProcessStep[];
  valueParameters: ValueParameter[];
  ontologyGraphNodes: OntologyGraphNode[];
  ontologyGraphEdges: OntologyGraphEdge[];
}

export interface OntologyStep {
  id: "customer" | "need" | "scenario" | "product" | "process" | "usage" | "value";
  label: string;
  tone: "cyan" | "blue" | "violet" | "amber" | "green" | "pink" | "lime";
}

export interface FeatureSet {
  avgBalance90d: number;
  currentBalance: number;
  outgoingCount: number;
  incomingCount: number;
  supplierTxns: Transaction[];
  vehicleTxns: Transaction[];
  payrollTxns: Transaction[];
  taxTxns: Transaction[];
  collectTxns: Transaction[];
  transferTxns: Transaction[];
  directTxns: Transaction[];
  topCounterparties: Array<{ name: string; count: number }>;
}

export interface FundNeed {
  needId: string;
  needType: string;
  confidence: number;
  evidenceTxnIds: string[];
  explanation: string;
}

export interface Scenario {
  scenarioId: string;
  scenarioName: string;
  triggerNeedId: string;
  confidence: number;
  evidence: string;
  evidenceTxnIds: string[];
  evidenceRows: Transaction[];
}

export interface ProductBundle {
  scenarioId: string;
  scenarioName: string;
  bundleName: string;
  products: Product[];
  missingProducts: Product[];
  fitReason: string;
  verifyQuestion: string;
}

export type CoverageStatus = "已覆盖" | "部分覆盖" | "未覆盖";

export interface CoverageRow {
  scenarioName: string;
  status: CoverageStatus;
  signedCount: number;
  totalCount: number;
  missingProducts: string[];
  description: string;
}

export interface ValueResult {
  valueId: string;
  customerId: string;
  opportunityType: string;
  estimatedDepositIncrease: number;
  estimatedTxnIncrease: number;
  actionOwner: string;
  nextAction: string;
}

export interface CustomerAnalysis {
  customer: Customer;
  accounts: Account[];
  transactions: Transaction[];
  usages: ProductUsage[];
  features: FeatureSet;
  needs: FundNeed[];
  scenarios: Scenario[];
  bundles: ProductBundle[];
  coverage: CoverageRow[];
  value: ValueResult;
}

export interface BranchOpportunity {
  customerId: string;
  customerName: string;
  managerName: string;
  topScenario: string;
  opportunity: string;
  nextAction: string;
  estimatedDepositIncrease: number;
  estimatedTxnIncrease: number;
}

export interface BranchAnalysis {
  customerCount: number;
  scenarioCounts: Record<string, number>;
  opportunityCount: number;
  totalDepositIncrease: number;
  totalTxnIncrease: number;
  opportunities: BranchOpportunity[];
}

export interface AiInsight {
  title: string;
  promptKey: string;
  text: string;
  prompts: string[];
}

export interface AssistantMessage {
  role: "assistant" | "user";
  text: string;
  promptKey?: string;
  confidence?: number;
  sources?: string[];
}
