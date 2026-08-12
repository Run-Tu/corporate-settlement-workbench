import json
import sqlite3
from datetime import date, timedelta
from pathlib import Path

API_ROOT = Path(__file__).resolve().parent
DATA_DIR = API_ROOT / "data"
DB_PATH = DATA_DIR / "settlement_demo.sqlite"
SEED_PATH = DATA_DIR / "seed_data.json"

class SettlementRepository:

    def __init__(self, db_path=None):
        self.db_path = Path(db_path or DB_PATH)

    def get_all_data(self):

        self._ensure_database_exists()
        with self._connect() as conn:
            return {
                "branch": self._one(conn, "SELECT * FROM branches LIMIT 1", _branch_row),
                "customers": self._many(conn, "SELECT * FROM customers ORDER BY customer_id", _customer_row),
                "accounts": self._many(conn, "SELECT * FROM accounts ORDER BY account_id", _account_row),
                "products": self._many(conn, "SELECT * FROM products ORDER BY product_id", _product_row),
                "productUsage": self._many(conn, "SELECT * FROM product_usage ORDER BY usage_id", _usage_row),
                "transactions": self._many(conn, "SELECT * FROM transactions ORDER BY txn_date, txn_id", _transaction_row),
                "customerRelations": self._many(conn, "SELECT * FROM customer_relations ORDER BY relation_id", _relation_row),
                "balanceSnapshots": self._many(conn, "SELECT * FROM balance_snapshots ORDER BY customer_id, snapshot_date", _balance_snapshot_row),
                "industryProfiles": self._many(conn, "SELECT * FROM industry_profiles ORDER BY customer_id", _industry_profile_row),
                "scenarioRules": self._many(conn, "SELECT * FROM scenario_rules ORDER BY rule_id", _scenario_rule_row),
                "processSteps": self._many(conn, "SELECT * FROM process_steps ORDER BY customer_id, step_order", _process_step_row),
                "valueParameters": self._many(conn, "SELECT * FROM value_parameters ORDER BY customer_id", _value_parameter_row),
                "ontologyGraphNodes": self._many(conn, "SELECT * FROM ontology_graph_nodes ORDER BY customer_id, step_id, node_id", _ontology_graph_node_row),
                "ontologyGraphEdges": self._many(conn, "SELECT * FROM ontology_graph_edges ORDER BY customer_id, step_id, edge_id", _ontology_graph_edge_row),
            }

    def _connect(self):

        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        return conn

    def _ensure_database_exists(self):

        if not self.db_path.exists():
            raise FileNotFoundError(f"SQLite database not found: {self.db_path}. Run `python3 apps/api/init_db.py`.")

    @staticmethod
    def _one(conn, sql, mapper):

        row = conn.execute(sql).fetchone()
        return mapper(row) if row else {}

    @staticmethod
    def _many(conn, sql, mapper):

        return [mapper(row) for row in conn.execute(sql).fetchall()]

def initialize_database(db_path=None, seed_path=None):

    db_path = Path(db_path or DB_PATH)
    seed_path = Path(seed_path or SEED_PATH)
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    if db_path.exists():
        db_path.unlink()

    seed = json.loads(seed_path.read_text(encoding="utf-8"))
    with sqlite3.connect(db_path) as conn:
        _create_schema(conn)
        _insert_seed(conn, seed)
        conn.commit()
    return db_path

def _create_schema(conn):

    conn.executescript(
        """
        CREATE TABLE branches (
          branch_id TEXT PRIMARY KEY,
          branch_name TEXT NOT NULL,
          region TEXT NOT NULL,
          analysis_period TEXT NOT NULL
        );

        CREATE TABLE customers (
          customer_id TEXT PRIMARY KEY,
          customer_name TEXT NOT NULL,
          industry TEXT NOT NULL,
          branch_id TEXT NOT NULL,
          branch_name TEXT NOT NULL,
          manager_name TEXT NOT NULL,
          customer_tier TEXT NOT NULL,
          tags_json TEXT NOT NULL
        );

        CREATE TABLE accounts (
          account_id TEXT PRIMARY KEY,
          customer_id TEXT NOT NULL,
          account_name TEXT NOT NULL,
          account_type TEXT NOT NULL,
          balance REAL NOT NULL,
          avg_balance_90d REAL NOT NULL
        );

        CREATE TABLE products (
          product_id TEXT PRIMARY KEY,
          product_name TEXT NOT NULL,
          product_type TEXT NOT NULL,
          fit_scenarios_json TEXT NOT NULL,
          required_materials TEXT NOT NULL,
          value_point TEXT NOT NULL
        );

        CREATE TABLE product_usage (
          usage_id TEXT PRIMARY KEY,
          customer_id TEXT NOT NULL,
          product_id TEXT NOT NULL,
          signed INTEGER NOT NULL,
          activated INTEGER NOT NULL,
          txn_count_90d INTEGER NOT NULL,
          txn_amount_90d REAL NOT NULL,
          last_used_date TEXT NOT NULL,
          usage_status TEXT NOT NULL
        );

        CREATE TABLE transactions (
          txn_id TEXT PRIMARY KEY,
          customer_id TEXT NOT NULL,
          account_id TEXT NOT NULL,
          txn_date TEXT NOT NULL,
          direction TEXT NOT NULL,
          amount REAL NOT NULL,
          balance_after REAL NOT NULL,
          counterparty_name TEXT NOT NULL,
          counterparty_type TEXT NOT NULL,
          summary TEXT NOT NULL,
          channel TEXT NOT NULL
        );

        CREATE TABLE customer_relations (
          relation_id TEXT PRIMARY KEY,
          customer_id TEXT NOT NULL,
          relation_type TEXT NOT NULL,
          related_name TEXT NOT NULL,
          role_name TEXT NOT NULL,
          ownership_ratio REAL NOT NULL,
          relation_strength REAL NOT NULL
        );

        CREATE TABLE balance_snapshots (
          snapshot_id TEXT PRIMARY KEY,
          customer_id TEXT NOT NULL,
          snapshot_date TEXT NOT NULL,
          balance REAL NOT NULL,
          balance_type TEXT NOT NULL
        );

        CREATE TABLE industry_profiles (
          profile_id TEXT PRIMARY KEY,
          customer_id TEXT NOT NULL,
          industry_name TEXT NOT NULL,
          industry_chain TEXT NOT NULL,
          upstream_tags_json TEXT NOT NULL,
          downstream_tags_json TEXT NOT NULL,
          business_pattern TEXT NOT NULL
        );

        CREATE TABLE scenario_rules (
          rule_id TEXT PRIMARY KEY,
          scenario_name TEXT NOT NULL,
          rule_name TEXT NOT NULL,
          evidence_type TEXT NOT NULL,
          weight REAL NOT NULL
        );

        CREATE TABLE process_steps (
          process_step_id TEXT PRIMARY KEY,
          customer_id TEXT NOT NULL,
          step_order INTEGER NOT NULL,
          step_name TEXT NOT NULL,
          owner_role TEXT NOT NULL,
          required_material TEXT NOT NULL,
          estimated_days INTEGER NOT NULL
        );

        CREATE TABLE value_parameters (
          value_parameter_id TEXT PRIMARY KEY,
          customer_id TEXT NOT NULL,
          deposit_retention_rate REAL NOT NULL,
          txn_capture_rate REAL NOT NULL,
          opportunity_score REAL NOT NULL,
          similar_customer_count INTEGER NOT NULL
        );

        CREATE TABLE ontology_graph_nodes (
          node_id TEXT PRIMARY KEY,
          customer_id TEXT NOT NULL,
          step_id TEXT NOT NULL,
          node_type TEXT NOT NULL,
          node_name TEXT NOT NULL,
          node_badge TEXT NOT NULL,
          node_detail TEXT NOT NULL,
          details_json TEXT NOT NULL,
          position_x REAL NOT NULL,
          position_y REAL NOT NULL,
          importance REAL NOT NULL
        );

        CREATE TABLE ontology_graph_edges (
          edge_id TEXT PRIMARY KEY,
          customer_id TEXT NOT NULL,
          step_id TEXT NOT NULL,
          source_node_id TEXT NOT NULL,
          target_node_id TEXT NOT NULL,
          relation_name TEXT NOT NULL,
          relation_detail TEXT NOT NULL,
          weight REAL NOT NULL
        );
        """
    )

def _insert_seed(conn, seed):

    branch = seed["branch"]
    conn.execute(
        "INSERT INTO branches VALUES (?, ?, ?, ?)",
        (branch["branchId"], branch["branchName"], branch["region"], branch["analysisPeriod"]),
    )

    conn.executemany(
        "INSERT INTO customers VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [
            (
                row["customerId"],
                row["customerName"],
                row["industry"],
                row["branchId"],
                row["branchName"],
                row["managerName"],
                row["customerTier"],
                json.dumps(row["tags"], ensure_ascii=False),
            )
            for row in seed["customers"]
        ],
    )
    conn.executemany(
        "INSERT INTO accounts VALUES (?, ?, ?, ?, ?, ?)",
        [(row["accountId"], row["customerId"], row["accountName"], row["accountType"], row["balance"], row["avgBalance90d"]) for row in seed["accounts"]],
    )
    conn.executemany(
        "INSERT INTO products VALUES (?, ?, ?, ?, ?, ?)",
        [
            (
                row["productId"],
                row["productName"],
                row["productType"],
                json.dumps(row["fitScenarios"], ensure_ascii=False),
                row["requiredMaterials"],
                row["valuePoint"],
            )
            for row in seed["products"]
        ],
    )
    conn.executemany(
        "INSERT INTO product_usage VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
            (
                row["usageId"],
                row["customerId"],
                row["productId"],
                int(row["signed"]),
                int(row["activated"]),
                row["txnCount90d"],
                row["txnAmount90d"],
                row["lastUsedDate"],
                row["usageStatus"],
            )
            for row in seed["productUsage"]
        ],
    )
    transactions = _expand_transactions(seed)
    conn.executemany(
        "INSERT INTO transactions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
            (
                row["txnId"],
                row["customerId"],
                row["accountId"],
                row["txnDate"],
                row["direction"],
                row["amount"],
                row["balanceAfter"],
                row["counterpartyName"],
                row["counterpartyType"],
                row["summary"],
                row["channel"],
            )
            for row in transactions
        ],
    )
    _insert_graph_seed(conn, {**seed, "transactions": transactions})

def _expand_transactions(seed):

    transactions = [dict(row) for row in seed["transactions"]]
    period_start = date(2026, 3, 1)
    period_end = date(2026, 5, 31)
    amount_factors = (0.34, 0.52, 0.71, 0.88, 1.04, 1.17)

    for customer_index, customer in enumerate(seed["customers"], start=1):
        customer_id = customer["customerId"]
        suffix = customer_id[-3:]
        source_rows = [row for row in seed["transactions"] if row["customerId"] == customer_id]
        account_rows = [row for row in seed["accounts"] if row["customerId"] == customer_id]
        account_by_id = {row["accountId"]: row for row in account_rows}

        if not source_rows or not account_rows:
            continue

        generated_index = 0
        current_date = period_start
        while current_date <= period_end:
            day_index = (current_date - period_start).days

            if (day_index + customer_index) % 7 != 0:
                source = source_rows[(day_index * 3 + customer_index) % len(source_rows)]
                generated_index += 1
                factor = amount_factors[(day_index + customer_index) % len(amount_factors)]
                amount = max(1800, round(source["amount"] * factor / 100) * 100)
                account = account_by_id.get(source["accountId"], account_rows[day_index % len(account_rows)])
                balance_factor = 0.78 + ((day_index * 11 + customer_index * 7) % 31) / 100
                direction_effect = amount * (0.025 if source["direction"] == "in" else -0.018)
                balance_after = max(50000, round(account["balance"] * balance_factor + direction_effect))

                transactions.append(
                    {
                        "txnId": f"TXN-SIM-{suffix}-{generated_index:03d}",
                        "customerId": customer_id,
                        "accountId": account["accountId"],
                        "txnDate": current_date.isoformat(),
                        "direction": source["direction"],
                        "amount": amount,
                        "balanceAfter": balance_after,
                        "counterpartyName": source["counterpartyName"],
                        "counterpartyType": source["counterpartyType"],
                        "summary": source["summary"],
                        "channel": source["channel"],
                    }
                )
            current_date += timedelta(days=1)

    return transactions

def _insert_graph_seed(conn, seed):

    industry_patterns = {
        "高端制造": ("装备制造产业链", ["精密零部件", "工业服务"], ["轨交装备", "工程项目"], "订单回款后集中采购，供应商付款具有周期性"),
        "连锁餐饮": ("连锁消费服务产业链", ["食材供应", "门店租赁"], ["门店消费者", "平台渠道"], "门店收款高频汇总，工资和采购支出周期稳定"),
        "物流运输": ("物流运输产业链", ["油品服务", "车辆维保"], ["生产企业", "商贸客户"], "车辆运营支出高频，ETC、油费和维修费用集中"),
        "医药流通": ("医药供应链", ["药品厂商", "器械供应"], ["医院平台", "零售终端"], "上下游账期明显，采购付款和平台回款金额较高"),
        "物业服务": ("城市服务产业链", ["保洁外包", "设备维保"], ["园区客户", "住宅社区"], "工资、社保和日常服务支出具有固定周期"),
        "科技服务": ("企业数字服务产业链", ["技术采购", "人力外包"], ["项目客户", "集团客户"], "项目回款后存在多账户调拨和阶段性资金沉淀"),
        "建筑工程": ("建筑产业链", ["建材供应", "劳务外包"], ["地产开发商", "政府项目"], "工程进度款分批支付，材料采购和劳务支出集中"),
        "跨境电商": ("跨境贸易产业链", ["海外供应商", "物流仓储"], ["海外消费者", "平台渠道"], "跨境收付款频繁，汇率波动影响资金规划"),
        "教育培训": ("教育服务产业链", ["课程研发", "师资外包"], ["学员家长", "企业客户"], "学费收入季节性集中，工资和租金支出固定"),
        "新能源": ("新能源产业链", ["原材料供应", "设备制造"], ["电网公司", "储能客户"], "设备销售回款周期较长，研发投入和原材料采购支出大"),
    }
    scenario_rules = [
        ("RULE-001", "供应商付款场景", "固定对公支出", "交易频率与对手方集中度", 0.35),
        ("RULE-002", "闲置资金沉淀场景", "余额持续高位", "90 日账户余额趋势", 0.4),
        ("RULE-003", "车辆出行场景", "车辆关键词命中", "摘要与对手方关键词", 0.42),
        ("RULE-004", "代发工资场景", "固定日期工资支出", "交易周期与摘要关键词", 0.38),
        ("RULE-005", "税费社保缴纳场景", "机构缴费关键词", "对手方类型与摘要关键词", 0.36),
        ("RULE-006", "门店收款场景", "门店清算入账", "收款渠道与摘要关键词", 0.4),
        ("RULE-007", "资金归集场景", "多账户内部划转", "账户关系与调拨摘要", 0.4),
        ("RULE-008", "银企对接场景", "银企直联高频交易", "交易渠道与对账复杂度", 0.34),
    ]
    conn.executemany("INSERT INTO scenario_rules VALUES (?, ?, ?, ?, ?)", scenario_rules)

    for index, customer in enumerate(seed["customers"], start=1):
        customer_id = customer["customerId"]
        suffix = customer_id[-3:]
        industry_chain, upstream, downstream, business_pattern = industry_patterns[customer["industry"]]
        relations = [
            (f"REL-{suffix}-01", customer_id, "branch", customer["branchName"], "开户支行", 0, 0.96),
            (f"REL-{suffix}-02", customer_id, "controller", f"{customer['managerName'][0]}某", "实际控制人", 62 + index, 0.92),
            (f"REL-{suffix}-03", customer_id, "executive", f"{customer['managerName'][0]}某某", "财务负责人", 0, 0.86),
            (f"REL-{suffix}-04", customer_id, "executive", f"{customer['managerName'][0]}总", "总经理", 0, 0.82),
            (f"REL-{suffix}-05", customer_id, "affiliate", f"{customer['customerName'][:4]}供应链有限公司", "关联企业", 28 + index, 0.74),
            (f"REL-{suffix}-06", customer_id, "affiliate", f"{customer['customerName'][:4]}服务有限公司", "关联企业", 18 + index, 0.68),
        ]
        conn.executemany("INSERT INTO customer_relations VALUES (?, ?, ?, ?, ?, ?, ?)", relations)

        account_rows = [row for row in seed["accounts"] if row["customerId"] == customer_id]
        balance_base = sum(row["balance"] for row in account_rows)
        balance_rows = []
        period_start = date(2026, 3, 1)
        period_end = date(2026, 5, 31)
        current_date = period_start
        while current_date <= period_end:
            day_index = (current_date - period_start).days
            cycle = ((day_index * 7 + index * 11) % 29) / 100
            month_lift = 0.04 if current_date.month == 4 else 0.08 if current_date.month == 5 else 0
            factor = 0.76 + cycle + month_lift
            balance_rows.append((f"BAL-{suffix}-{day_index + 1:03d}", customer_id, current_date.isoformat(), round(balance_base * factor), "日终余额"))
            current_date += timedelta(days=1)
        conn.executemany("INSERT INTO balance_snapshots VALUES (?, ?, ?, ?, ?)", balance_rows)

        conn.execute(
            "INSERT INTO industry_profiles VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                f"IND-{suffix}",
                customer_id,
                customer["industry"],
                industry_chain,
                json.dumps(upstream, ensure_ascii=False),
                json.dumps(downstream, ensure_ascii=False),
                business_pattern,
            ),
        )

        process_rows = [
            (f"PROC-{suffix}-01", customer_id, 1, "核实经营痛点", "客户经理", "场景证据流水、客户拜访提纲", 1),
            (f"PROC-{suffix}-02", customer_id, 2, "准备办理材料", "客户经理 / 产品经理", "账户授权、企业资料、产品签约材料", 2),
            (f"PROC-{suffix}-03", customer_id, 3, "完成产品开通", "运营支持岗", "审批单、系统配置、授权协议", 3),
            (f"PROC-{suffix}-04", customer_id, 4, "跟踪使用效果", "客户经理", "首月交易、活跃度、沉淀变化", 30),
        ]
        conn.executemany("INSERT INTO process_steps VALUES (?, ?, ?, ?, ?, ?, ?)", process_rows)

        conn.execute(
            "INSERT INTO value_parameters VALUES (?, ?, ?, ?, ?, ?)",
            (f"VP-{suffix}", customer_id, round(0.12 + index * 0.012, 3), round(0.36 + index * 0.018, 3), 70 + index * 4, 2 + index),
        )
        graph_balance_rows = [balance_rows[position] for position in (0, 30, 60, len(balance_rows) - 1)]
        _insert_ontology_graph(conn, seed, customer, suffix, index, account_rows, graph_balance_rows, relations, process_rows, upstream, downstream, industry_chain, business_pattern)

def _insert_ontology_graph(conn, seed, customer, suffix, index, accounts, balances, relations, process_steps, upstream, downstream, industry_chain, business_pattern):

    customer_id = customer["customerId"]
    customer_name = customer["customerName"]
    manager_name = customer["managerName"]
    products = seed["products"]
    usages = [row for row in seed["productUsage"] if row["customerId"] == customer_id]
    transactions = [row for row in seed["transactions"] if row["customerId"] == customer_id]
    graph_nodes = []
    graph_edges = []

    def add_node(step_id, node_id, node_type, node_name, badge, detail, details, x, y, importance=0.7):
        graph_nodes.append((node_id, customer_id, step_id, node_type, node_name, badge, detail, json.dumps(details, ensure_ascii=False), x, y, importance))

    def add_edge(step_id, edge_id, source, target, relation_name, relation_detail, weight=0.7):
        graph_edges.append((edge_id, customer_id, step_id, source, target, relation_name, relation_detail, weight))

    def add_radial(step_id, center_id, rows):
        for row_index, row in enumerate(rows, start=1):
            node_id, node_type, node_name, badge, detail, details, x, y, relation_name, relation_detail, weight = row
            add_node(step_id, node_id, node_type, node_name, badge, detail, details, x, y, weight)
            add_edge(step_id, f"OGE-{suffix}-{step_id}-{row_index:02d}", center_id, node_id, relation_name, relation_detail, weight)

    customer_center = f"OGN-{suffix}-customer-center"
    add_node("customer", customer_center, "customer", customer_name, "目标客户", customer["industry"], [customer["customerTier"], *customer["tags"]], 48, 51, 1)
    customer_rows = []
    customer_coordinates = [(22, 18), (43, 14), (72, 18), (84, 39), (82, 68), (64, 84), (36, 84), (18, 65), (18, 40), (38, 34)]
    for row_index, relation in enumerate(relations):
        _, _, relation_type, related_name, role_name, ownership, strength = relation
        customer_rows.append((f"OGN-{suffix}-customer-rel-{row_index + 1}", relation_type, related_name, role_name, f"关联强度 {round(strength * 100)}%", [f"持股比例：{ownership}%", f"角色：{role_name}"], *customer_coordinates[row_index], role_name, f"{related_name}与客户的{role_name}关系", strength))
    for row_index, account in enumerate(accounts[:2]):
        customer_rows.append((f"OGN-{suffix}-customer-account-{row_index + 1}", "account", account["accountName"], account["accountType"], f"余额 {round(account['balance'] / 10000)} 万", [f"90 日均额：{round(account['avgBalance90d'] / 10000)} 万"], *customer_coordinates[6 + row_index], "持有账户", "客户名下结算账户", 0.82))
    for row_index, tag in enumerate(customer["tags"][:2]):
        customer_rows.append((f"OGN-{suffix}-customer-tag-{row_index + 1}", "tag", tag, "客户标签", "画像标签", [f"行业：{customer['industry']}"], *customer_coordinates[8 + row_index], "具备标签", "客户画像特征", 0.62))
    add_radial("customer", customer_center, customer_rows)

    need_center = f"OGN-{suffix}-need-center"
    need_name = "闲置资金管理" if sum(row["balance"] for row in accounts) > 4500000 else "付款效率提升"
    add_node("need", need_center, "need", need_name, "核心资金需求", "基于余额趋势与交易行为识别", ["需求置信度：88%", f"客户：{customer_name}"], 48, 51, 1)
    need_rows = []
    need_coordinates = [(20, 18), (42, 13), (70, 18), (84, 37), (84, 65), (68, 84), (40, 86), (18, 66), (17, 40), (37, 34)]
    for row_index, balance in enumerate(balances):
        snapshot_id, _, snapshot_date, amount, balance_type = balance
        need_rows.append((f"OGN-{suffix}-need-bal-{row_index + 1}", "balance", snapshot_date, balance_type, f"{round(amount / 10000)} 万", ["日终余额快照", f"日期：{snapshot_date}"], *need_coordinates[row_index], "形成余额趋势", "90 日资金沉淀变化", 0.78))
    for row_index, txn in enumerate(transactions[:4]):
        need_rows.append((f"OGN-{suffix}-need-txn-{row_index + 1}", "transaction", txn["counterpartyName"], "证据流水", f"{round(txn['amount'] / 10000)} 万", [txn["txnDate"], txn["summary"], txn["channel"]], *need_coordinates[4 + row_index], "提供交易证据", txn["summary"], 0.72))
    need_rows.extend([
        (f"OGN-{suffix}-need-metric-1", "metric", "90 日均额", "资金指标", f"{round(sum(row['avgBalance90d'] for row in accounts) / max(len(accounts), 1) / 10000)} 万", ["衡量稳定沉淀水平"], *need_coordinates[8], "参与需求判断", "账户长期资金水位", 0.84),
        (f"OGN-{suffix}-need-metric-2", "metric", "高频付款", "行为指标", f"{len([row for row in transactions if row['direction'] == 'out'])} 笔", ["衡量付款效率机会"], *need_coordinates[9], "参与需求判断", "对公支出频率", 0.74),
    ])
    add_radial("need", need_center, need_rows)

    scenario_center = f"OGN-{suffix}-scenario-center"
    scenario_name = _scenario_name_for_customer(customer["industry"])
    add_node("scenario", scenario_center, "scenario", scenario_name, "推荐结算场景", business_pattern, [industry_chain, f"客户：{customer_name}"], 48, 51, 1)
    scenario_rows = [
        (f"OGN-{suffix}-scenario-chain", "industry", industry_chain, "产业链", business_pattern, [customer["industry"]], 22, 18, "提供行业背景", "经营链路决定结算行为", 0.82),
        (f"OGN-{suffix}-scenario-up-1", "upstream", upstream[0], "上游主体", "采购付款端", ["产业链上游"], 46, 13, "形成采购支出", "解释付款端交易", 0.74),
        (f"OGN-{suffix}-scenario-up-2", "upstream", upstream[1], "上游主体", "服务采购端", ["产业链上游"], 72, 19, "形成采购支出", "解释付款端交易", 0.7),
        (f"OGN-{suffix}-scenario-down-1", "downstream", downstream[0], "下游主体", "经营回款端", ["产业链下游"], 85, 40, "形成经营回款", "解释收入端交易", 0.74),
        (f"OGN-{suffix}-scenario-down-2", "downstream", downstream[1], "下游主体", "项目回款端", ["产业链下游"], 82, 69, "形成经营回款", "解释收入端交易", 0.7),
        (f"OGN-{suffix}-scenario-rule-1", "rule", "固定对公支出", "识别规则", "权重 35%", ["交易频率与对手方集中度"], 64, 85, "命中识别规则", "规则参与场景评分", 0.78),
        (f"OGN-{suffix}-scenario-rule-2", "rule", "余额持续高位", "识别规则", "权重 40%", ["90 日账户余额趋势"], 37, 85, "命中识别规则", "规则参与场景评分", 0.8),
        (f"OGN-{suffix}-scenario-channel", "channel", transactions[0]["channel"] if transactions else "网银", "结算渠道", "交易渠道特征", ["交易行为维度"], 18, 65, "支撑场景判断", "渠道反映企业结算习惯", 0.66),
    ]
    add_radial("scenario", scenario_center, scenario_rows)

    product_center = f"OGN-{suffix}-product-center"
    recommended_products = _products_for_industry(products, customer["industry"])
    bundle_name = " + ".join(row["productName"] for row in recommended_products[:3])
    add_node("product", product_center, "bundle", bundle_name, "推荐产品组合", f"匹配{scenario_name}", [f"客户：{customer_name}", f"场景：{scenario_name}"], 48, 51, 1)
    product_coordinates = [(20, 18), (43, 13), (70, 18), (85, 38), (84, 67), (66, 84), (39, 85), (18, 65)]
    product_rows = []
    for row_index, product in enumerate(recommended_products[:6]):
        product_rows.append((f"OGN-{suffix}-product-{row_index + 1}", "product", product["productName"], product["productType"], product["valuePoint"], [f"办理材料：{product['requiredMaterials']}"], *product_coordinates[row_index], "推荐配置", f"匹配{scenario_name}", 0.88 - row_index * 0.045))
    product_rows.extend([
        (f"OGN-{suffix}-product-gap", "gap", "产品覆盖缺口", "诊断结论", "建议补齐组合配置", ["优先核验签约状态"], *product_coordinates[6], "发现缺口", "影响场景完整覆盖", 0.76),
        (f"OGN-{suffix}-product-owner", "owner", manager_name, "客户经理", "负责推动产品组合落地", ["责任人"], *product_coordinates[7], "负责推进", "承接推荐方案", 0.68),
    ])
    add_radial("product", product_center, product_rows)

    process_center = f"OGN-{suffix}-process-center"
    add_node("process", process_center, "process", f"{customer_name}办理路径", "办理作战卡", "从核验到跟踪形成闭环", [f"责任人：{manager_name}"], 48, 51, 1)
    process_coordinates = [(19, 18), (40, 16), (63, 20), (82, 36), (83, 63), (64, 82), (40, 84), (20, 66)]
    process_rows = []
    for row_index, process in enumerate(process_steps):
        process_rows.append((f"OGN-{suffix}-process-{row_index + 1}", "process", process[3], f"办理动作 0{process[2]}", f"{process[6]} 天", [f"责任角色：{process[4]}", f"材料：{process[5]}"], *process_coordinates[row_index], "下一步", "按办理顺序推进", 0.86 - row_index * 0.04))
    process_rows.extend([
        (f"OGN-{suffix}-process-material", "material", "企业签约材料", "材料包", "账户授权、企业资料", ["办理材料"], *process_coordinates[4], "准备材料", "支撑产品开通", 0.7),
        (f"OGN-{suffix}-process-owner", "owner", manager_name, "客户经理", "客户沟通与进度协调", ["主责任人"], *process_coordinates[5], "负责协调", "保障流程推进", 0.72),
        (f"OGN-{suffix}-process-support", "owner", "运营支持岗", "协同岗位", "系统配置与审批", ["协同责任人"], *process_coordinates[6], "协同办理", "保障系统开通", 0.68),
        (f"OGN-{suffix}-process-result", "result", "首月使用跟踪", "闭环动作", "跟踪活跃度与沉淀变化", ["使用效果回访"], *process_coordinates[7], "形成闭环", "回流使用诊断", 0.76),
    ])
    _add_sequence_graph(add_node, add_edge, suffix, "process", process_center, process_rows)

    usage_center = f"OGN-{suffix}-usage-center"
    add_node("usage", usage_center, "usage", f"{customer_name}使用诊断", "活跃度诊断", f"{len(usages)} 项产品使用记录", [f"客户：{customer_name}"], 48, 51, 1)
    usage_coordinates = [(20, 18), (43, 13), (70, 18), (85, 38), (84, 67), (66, 84), (39, 85), (18, 65)]
    usage_rows = []
    for row_index, usage in enumerate(usages[:5]):
        product = next((row for row in products if row["productId"] == usage["productId"]), {"productName": usage["productId"]})
        status = "已激活" if usage["activated"] else "待激活"
        usage_rows.append((f"OGN-{suffix}-usage-{row_index + 1}", "usage", product["productName"], status, f"90 日 {usage['txnCount90d']} 笔", [f"交易金额：{round(usage['txnAmount90d'] / 10000)} 万", f"最后使用：{usage['lastUsedDate']}"], *usage_coordinates[row_index], status, "反映产品使用深度", 0.84 if usage["activated"] else 0.66))
    usage_rows.extend([
        (f"OGN-{suffix}-usage-metric-1", "metric", "激活产品数", "使用指标", f"{len([row for row in usages if row['activated']])} 项", ["衡量激活深度"], *usage_coordinates[5], "汇总形成", "反映产品激活水平", 0.78),
        (f"OGN-{suffix}-usage-metric-2", "metric", "90 日交易笔数", "使用指标", f"{sum(row['txnCount90d'] for row in usages)} 笔", ["衡量交易活跃度"], *usage_coordinates[6], "汇总形成", "反映客户活跃度", 0.76),
        (f"OGN-{suffix}-usage-gap", "gap", "待提升使用深度", "诊断结论", "补齐签约与激活缺口", ["持续跟踪首月使用"], *usage_coordinates[7], "形成诊断", "识别下一步运营动作", 0.74),
    ])
    add_radial("usage", usage_center, usage_rows)

    value_center = f"OGN-{suffix}-value-center"
    score = 70 + index * 4
    add_node("value", value_center, "value", f"{customer_name}价值闭环", "机会测算", f"机会评分 {score} 分", [f"责任人：{manager_name}"], 48, 51, 1)
    value_rows = [
        (f"OGN-{suffix}-value-score", "metric", "机会评分", "价值参数", f"{score} 分", ["客户机会优先级"], 19, 18, "输入参数", "参与价值测算", 0.88),
        (f"OGN-{suffix}-value-retention", "metric", "存款留存率", "价值参数", f"{round((0.12 + index * 0.012) * 100)}%", ["沉淀测算参数"], 40, 16, "输入参数", "参与存款提升测算", 0.82),
        (f"OGN-{suffix}-value-capture", "metric", "交易承接率", "价值参数", f"{round((0.36 + index * 0.018) * 100)}%", ["交易测算参数"], 63, 20, "输入参数", "参与交易提升测算", 0.82),
        (f"OGN-{suffix}-value-deposit", "result", "预计存款提升", "价值结果", f"{round(sum(row['balance'] for row in accounts) * 0.18 / 10000)} 万", ["测算结果"], 82, 37, "测算得到", "形成存款提升机会", 0.9),
        (f"OGN-{suffix}-value-txn", "result", "预计交易提升", "价值结果", f"{round(sum(row['amount'] for row in transactions) * 0.16 / 10000)} 万", ["测算结果"], 83, 64, "测算得到", "形成交易提升机会", 0.88),
        (f"OGN-{suffix}-value-peers", "peer", "相似客户", "支行复制", f"{2 + index} 户", ["支行可复制机会"], 65, 83, "扩散机会", "形成支行盘户线索", 0.72),
        (f"OGN-{suffix}-value-owner", "owner", manager_name, "责任人", "承接下一步客户动作", ["客户经理"], 40, 84, "分配责任人", "推动机会转化", 0.76),
        (f"OGN-{suffix}-value-action", "action", "生成拜访任务", "下一步动作", "核实需求并推动产品配置", ["行动闭环"], 20, 66, "形成行动", "回流客户经营", 0.8),
    ]
    _add_sequence_graph(add_node, add_edge, suffix, "value", value_center, value_rows)

    conn.executemany("INSERT INTO ontology_graph_nodes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", graph_nodes)
    conn.executemany("INSERT INTO ontology_graph_edges VALUES (?, ?, ?, ?, ?, ?, ?, ?)", graph_edges)

def _add_sequence_graph(add_node, add_edge, suffix, step_id, center_id, rows):
    previous = center_id
    for row_index, row in enumerate(rows, start=1):
        node_id, node_type, node_name, badge, detail, details, x, y, relation_name, relation_detail, weight = row
        add_node(step_id, node_id, node_type, node_name, badge, detail, details, x, y, weight)
        add_edge(step_id, f"OGE-{suffix}-{step_id}-{row_index:02d}", previous, node_id, relation_name, relation_detail, weight)
        previous = node_id

def _scenario_name_for_customer(industry):
    return {
        "高端制造": "供应商付款场景",
        "连锁餐饮": "门店收款场景",
        "物流运输": "车辆出行场景",
        "医药流通": "供应商付款场景",
        "物业服务": "代发工资场景",
        "科技服务": "资金归集场景",
        "建筑工程": "供应商付款场景",
        "跨境电商": "资金归集场景",
        "教育培训": "代发工资场景",
        "新能源": "银企对接场景",
    }.get(industry, "综合结算场景")

def _products_for_industry(products, industry):
    scenario_name = _scenario_name_for_customer(industry)
    matched = [row for row in products if scenario_name in row["fitScenarios"]]
    remaining = [row for row in products if row not in matched]
    return [*matched, *remaining]

def _branch_row(row):

    return {
        "branchId": row["branch_id"],
        "branchName": row["branch_name"],
        "region": row["region"],
        "analysisPeriod": row["analysis_period"],
    }

def _customer_row(row):

    return {
        "customerId": row["customer_id"],
        "customerName": row["customer_name"],
        "industry": row["industry"],
        "branchId": row["branch_id"],
        "branchName": row["branch_name"],
        "managerName": row["manager_name"],
        "customerTier": row["customer_tier"],
        "tags": json.loads(row["tags_json"]),
    }

def _account_row(row):

    return {
        "accountId": row["account_id"],
        "customerId": row["customer_id"],
        "accountName": row["account_name"],
        "accountType": row["account_type"],
        "balance": row["balance"],
        "avgBalance90d": row["avg_balance_90d"],
    }

def _product_row(row):

    return {
        "productId": row["product_id"],
        "productName": row["product_name"],
        "productType": row["product_type"],
        "fitScenarios": json.loads(row["fit_scenarios_json"]),
        "requiredMaterials": row["required_materials"],
        "valuePoint": row["value_point"],
    }

def _usage_row(row):

    return {
        "usageId": row["usage_id"],
        "customerId": row["customer_id"],
        "productId": row["product_id"],
        "signed": bool(row["signed"]),
        "activated": bool(row["activated"]),
        "txnCount90d": row["txn_count_90d"],
        "txnAmount90d": row["txn_amount_90d"],
        "lastUsedDate": row["last_used_date"],
        "usageStatus": row["usage_status"],
    }

def _transaction_row(row):

    return {
        "txnId": row["txn_id"],
        "customerId": row["customer_id"],
        "accountId": row["account_id"],
        "txnDate": row["txn_date"],
        "direction": row["direction"],
        "amount": row["amount"],
        "balanceAfter": row["balance_after"],
        "counterpartyName": row["counterparty_name"],
        "counterpartyType": row["counterparty_type"],
        "summary": row["summary"],
        "channel": row["channel"],
    }

def _relation_row(row):
    return {
        "relationId": row["relation_id"],
        "customerId": row["customer_id"],
        "relationType": row["relation_type"],
        "relatedName": row["related_name"],
        "roleName": row["role_name"],
        "ownershipRatio": row["ownership_ratio"],
        "relationStrength": row["relation_strength"],
    }

def _balance_snapshot_row(row):
    return {
        "snapshotId": row["snapshot_id"],
        "customerId": row["customer_id"],
        "snapshotDate": row["snapshot_date"],
        "balance": row["balance"],
        "balanceType": row["balance_type"],
    }

def _industry_profile_row(row):
    return {
        "profileId": row["profile_id"],
        "customerId": row["customer_id"],
        "industryName": row["industry_name"],
        "industryChain": row["industry_chain"],
        "upstreamTags": json.loads(row["upstream_tags_json"]),
        "downstreamTags": json.loads(row["downstream_tags_json"]),
        "businessPattern": row["business_pattern"],
    }

def _scenario_rule_row(row):
    return {
        "ruleId": row["rule_id"],
        "scenarioName": row["scenario_name"],
        "ruleName": row["rule_name"],
        "evidenceType": row["evidence_type"],
        "weight": row["weight"],
    }

def _process_step_row(row):
    return {
        "processStepId": row["process_step_id"],
        "customerId": row["customer_id"],
        "stepOrder": row["step_order"],
        "stepName": row["step_name"],
        "ownerRole": row["owner_role"],
        "requiredMaterial": row["required_material"],
        "estimatedDays": row["estimated_days"],
    }

def _value_parameter_row(row):
    return {
        "valueParameterId": row["value_parameter_id"],
        "customerId": row["customer_id"],
        "depositRetentionRate": row["deposit_retention_rate"],
        "txnCaptureRate": row["txn_capture_rate"],
        "opportunityScore": row["opportunity_score"],
        "similarCustomerCount": row["similar_customer_count"],
    }

def _ontology_graph_node_row(row):
    return {
        "nodeId": row["node_id"],
        "customerId": row["customer_id"],
        "stepId": row["step_id"],
        "nodeType": row["node_type"],
        "nodeName": row["node_name"],
        "nodeBadge": row["node_badge"],
        "nodeDetail": row["node_detail"],
        "details": json.loads(row["details_json"]),
        "positionX": row["position_x"],
        "positionY": row["position_y"],
        "importance": row["importance"],
    }

def _ontology_graph_edge_row(row):
    return {
        "edgeId": row["edge_id"],
        "customerId": row["customer_id"],
        "stepId": row["step_id"],
        "sourceNodeId": row["source_node_id"],
        "targetNodeId": row["target_node_id"],
        "relationName": row["relation_name"],
        "relationDetail": row["relation_detail"],
        "weight": row["weight"],
    }
