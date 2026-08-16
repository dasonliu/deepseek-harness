# 闪耀智拍 × B 端离线授权（.lic）对接说明

> 实现日期：2026-08-15
> 涉及仓库：`UserManagement`（授权签发/管理/验签 SDK）、`LumiCapture`（闪耀智拍控制端/服务端）

## 1. 背景与目标

闪耀智拍（LumiCapture）控制端原有的授权体系是「C 端在线授权码」（`software_licenses` +
`verify_license` RPC，需要登录 + 设备绑定，**纯在线**）。企业客户在**无外网/局域网**环境下无法使用。

本次将闪耀智拍接入 UserManagement 已有的 **B 端离线授权体系**（`org_licenses` + RSA 签名的
`.lic` 离线 License 文件），实现：

- 管理后台为「闪耀智拍」产品签发 **离线授权 License**（.lic，RSA-2048 签名）
- 控制端**导入 .lic → 本地验签 → 宽限期校验 → 权限生效**，全程离线可用
- 局域网模式（未登录）下持有离线授权可直接进入主界面使用授权功能

## 2. 授权优先级（控制端）

```
登录会员 user_product_memberships   （最高）
    ↓
在线授权码 verify_license          （已激活、未过期）
    ↓
B 端离线授权 .lic                  （本地 RSA 验签 + 离线宽限期内）★ 本次新增
    ↓
免费版默认权限
```

## 3. 整体链路

```
┌────────────────────────── UserManagement 管理后台 ──────────────────────────┐
│ OrgLicenseAdminPage                                                          │
│  1. 选择组织 → 产品选「闪耀智拍」→ 填功能开关(feature_flags JSON) / 宽限天数    │
│  2. 签发 → org_licenses 表（自动生成 offline_activation_code）                │
│  3. 下载 → Edge Function GET /download/:id                                   │
│           └─ get_license_payload + RSA-2048 签名 → .lic 文件                  │
└──────────────────────────────────────────────────────────────────────────────┘
                                   ↓ 交付给客户
┌──────────────────────────── 闪耀智拍控制端 ────────────────────────────────┐
│ LicenseService → bllicense 模块                                             │
│  1. 导入 .lic → canonicalJson + RSA-SHA256 本地验签                          │
│  2. 公钥指纹(kid)匹配 → 到期/离线宽限期校验                                   │
│  3. 权限映射 → LicensePermissions（feature_flags 优先，其次 feature_mask）    │
│  4. 持久化 SharedPreferences；未登录时跳过登录页直接进主界面                    │
└──────────────────────────────────────────────────────────────────────────────┘
```

## 4. License File（.lic）结构

```json
{
  "version": 2,
  "license_id": "…",
  "issued_at": "2026-08-15T00:00:00Z",
  "expires_at": null,
  "offline_grace_days": 7,
  "last_online_at": null,
  "daily_offline_login_limit": 20,
  "offline_activation_code": "A1B2C3D4",
  "customer": { "org_id": "…", "org_name": "某企业", "contract_id": "…", "contact_email": "…" },
  "features": {
    "max_users": 10,
    "max_storage_gb": 100,
    "products": ["smart_shooting"],
    "offline_feature_mask": 511,
    "feature_flags": { "max_resolution": "4k", "wireless_source": true, "wireless_source_count": 6, "offline_usage": true, "private_deploy": true, "cloud_storage_management": true, "private_network_storage": true },
    "api_rate_limit": 1000
  },
  "hardware": { "bound": false, "fingerprint": null, "tolerance": 0.8 },
  "revocation": { "check_url": "…", "check_interval_hours": 24 },
  "security": {
    "sign_algorithm": "RS256",
    "public_key_fingerprint": "kid:blic-2026",
    "signature": "Base64(RSA-2048/SHA-256)"
  }
}
```

## 5. 签名 / 验签契约（关键）

| 环节 | 算法 | 签名内容 |
|---|---|---|
| 签名端（Edge Function `org-license-manage`） | RSA-2048 + RSASSA-PKCS1-v1_5 + SHA-256 | `canonicalJson(payload 去掉整个 security 字段)` |
| 验签端（管理端 SDK `license-validator.ts`） | 同上 | 同上（**已修复：原先误把 security 加回，导致必验签失败**） |
| 验签端（控制端 `rsa_verifier.dart`） | 同上 | 同上（pointycastle 实现） |

- `canonicalJson`：顶层 key 按字母序排序；数组内元素递归；嵌套对象保持原顺序。两端实现完全一致。
- 公钥表：`UM_PUBLIC_KEYS['kid:blic-2026']`（`um-rs256-v1` 为旧别名，共用同一把 RSA-2048 公钥）。
- 管理后台签发表单默认公钥指纹已统一为 `kid:blic-2026`。

## 6. 权限映射

控制端 `BLicenseService.permissions`：

1. **优先**：`features.feature_flags`（管理后台签发时写入的 JSON），直接
   `LicensePermissions.fromJson(flags)`。
   示例（企业档位）：
   `{"max_resolution":"4k","wireless_source":true,"wireless_source_count":6,"offline_usage":true,"private_deploy":true,"cloud_storage_management":true,"private_network_storage":true}`
2. 否则按 `offline_feature_mask` 位掩码：
   - bit0 离线授权 / bit1 无水印 / bit2 4K / bit3 1080p / bit4 无线信号源 /
     bit5 高级 AI / bit6 优先队列 / bit7 不限批处理
3. 都为空 → 免费版。

**档位分类（企业）**：`org_licenses.tier_code`（`enterprise` / `org_offline`）由管理后台签发时写入，
控制端离线授权生效时一律归类为「企业」档位（主题蓝展示，与会员金/免费灰并列），不依赖
`feature_flags`。`permission_summary` 为管理后台列表/详情展示用的权限摘要文案，控制端不消费。

## 7. 改动清单

### UserManagement（管理端）

| 文件 | 改动 |
|---|---|
| `src/lib/blicense/license-validator.ts` | **修复验签 bug**：签名内容改为「去掉整个 security 字段」，与签名端一致 |
| `src/config/blicense.ts` | 公钥表新增 `um-rs256-v1` 别名（兼容旧签发数据） |
| `src/pages/OrgLicenseAdminPage.tsx` | ① 下载改走 Edge Function `/download/:id`（签名版 .lic）；② 公钥指纹默认 `kid:blic-2026`；③ 签发表单新增 feature_flags(JSON) 输入；④ 自动生成 offline_activation_code；⑤ 产品选项含「闪耀智拍」；⑥ 组织操作新增**注销**（`toggle_org_suspend`，级联暂停其下 License，可恢复）、**启用**（级联恢复）与**删除**（`delete_org`，物理删除不可恢复）；⑦ 改用 `App.useApp()` 的 message（消除 antd 静态函数告警） |
| `src/lib/supabase.ts` | 备用登录用户（用户名+密码，无 JWT）读取 `localStorage['fallback_user']` 注入 `x-user-phone`/`x-user-email` 请求头，配合扩展后的 `is_admin_user()` 通过 RLS，解决管理端 401 |
| `supabase/migrations/20260816_add_enterprise_tier_admin.sql` | 企业档位迁移：`org_licenses` 加 `tier_code`/`permission_summary` 列；`issue_org_license` 增加 `p_tier_code`/`p_permission_summary` 参数（默认 `enterprise`，兼容旧调用）；`get_license_payload` 附带 `tier_code`；`product_membership_plans` 插入 `enterprise` 档位行；修复审计事件 CHECK 缺 `license.revoked` 导致吊销失败 |
| `supabase/functions/org-license-manage/index.ts` | 签发调用补 `p_tier_code`/`p_permission_summary` |
| `src/pages/OrgLicenseAdminPage.tsx` | 列表加「档位」（蓝标企业）+「权限摘要」列；签发表单加档位分类下拉（默认企业）与权限摘要自动生成（依据 feature_flags，与客户端权限明细文案一致）；详情展开加档位/权限摘要；**权限摘要已优化**：企业档位输出「4K 分辨率 · 无线信号源最高 6 路 · 离线使用/可私有部署 · 云存储管理+私有网络存储管理」等简洁文案，支持 `wireless_source_count` / `offline_usage` / `private_deploy` / `cloud_storage_management` / `private_network_storage` 字段 |

### 闪耀智拍（控制端 + 服务端）

| 文件 | 改动 |
|---|---|
| `capture_app/lib/services/bllicense/` | **新增模块**：`canonical_json.dart` / `rsa_verifier.dart` / `license_file.dart` / `bllicense_validator.dart` / `bllicense_service.dart` / `public_keys.dart` |
| `capture_app/lib/services/license_service.dart` | `permissions` getter 增加离线授权补位；`verify()` 网络失败/无授权码时优先离线授权；新增 `importOfflineLicense/clearOfflineLicense/applyOfflineAsStartup`；`tierLabel/hasPaidAccess` 纳入离线授权 |
| `capture_app/lib/ui/license_panel.dart` | 授权面板新增「离线授权」区块（导入 .lic / 查看状态 / 清除）；`_statusMeta` 增加离线授权状态 |
| `capture_app/lib/main.dart` | `_AuthGate._bootstrap`：未登录但持有有效离线授权 → 跳过登录页直接进主界面 |
| `capture_app/pubspec.yaml` | 新增依赖：`pointycastle`（RSA 验签）、`crypto`、`file_picker`（.lic 文件选择） |
| `app/server/index.js` | 新增 `POST /api/license/verify|heartbeat|activate|offline-logs` 代理到 Edge Function |
| `app/server/config.js` / `app/.env.example` | 新增 `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `LICENSE_EDGE_FUNCTION` 配置 |
| `README.md` | 授权流程/优先级/授权方式表/接入契约补充离线授权说明 |

## 8. 端到端验证步骤

1. **签发**：管理后台「B-License 后台」→ 选择组织 → 产品选「闪耀智拍」→
   填功能开关 JSON（如 `{"max_resolution":"4k","wireless_source":true,"wireless_source_count":6,"offline_usage":true,"private_deploy":true,"cloud_storage_management":true,"private_network_storage":true}`）→ 签发。
2. **下载**：列表操作「下载」→ 得到 `license_xxxx.lic`（含 `security.signature`）。
3. **控制端导入**：设置 → 账号 → 「离线授权」→ 导入离线授权文件 → 提示「离线授权已生效」。
4. **离线生效验证**：
   - 断网后重启控制端 → 跳过登录页直接进主界面；
   - 授权面板显示「某企业 离线授权已生效（离线余 N 天）」；
   - 分辨率/水印/无线信号源等权限按 feature_flags 生效。
5. **宽限期**：超过 `offline_grace_days` 后重新校验应失败并提示联系管理员续期。

## 9. 注意事项

- 控制端公钥表 `public_keys.dart` 需与 UserManagement `UM_PUBLIC_KEYS` 保持同步（换钥时同时更新两端）。
- 局域网无外网部署时服务端代理端点返回 501，控制端自动回退本地离线授权，不影响使用。
- 离线授权为设备级（非账号级），清除需在「离线授权」区块手动操作或调用 `clearOfflineLicense()`。
