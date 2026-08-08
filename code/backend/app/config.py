"""配置加载模块。

- 配置源：settings.json（项目根目录）+ 环境变量（env 覆盖）。
- 若 settings.json 缺失，自动写入一份默认配置后再加载。
- 端口统一取自 settings.port，代码内不得硬编码端口。

环境变量覆盖规则（优先级：环境变量 > settings.json > 默认值）：
- 顶层字段：BOSS_PORT
- 嵌套字段：BOSS_LLM__PROVIDER / BOSS_APPLY__DAILY_LIMIT 等（`__` 为嵌套分隔符）
"""

from __future__ import annotations

import base64
import ctypes
import ctypes.wintypes
import json
import os

from pydantic import BaseModel, Field, field_validator
from pydantic_settings import (
    BaseSettings,
    JsonConfigSettingsSource,
    PydanticBaseSettingsSource,
    SettingsConfigDict,
)

from app.constants import DEFAULT_PORT, PORT_MAX, PORT_MIN, SETTINGS_PATH

# ---------------------------------------------------------------------------
# 嵌套配置模型
# ---------------------------------------------------------------------------


class LLMConfig(BaseModel):
    """LLM 接入配置（DeepSeek/Qwen 等 OpenAI 兼容接口）。"""

    provider: str = "deepseek"
    api_key: str = ""
    model: str = "deepseek-chat"
    base_url: str = ""


class ApplyConfig(BaseModel):
    """投递合规限速配置。

    daily_limit/interval_seconds 边界与 electron/main.js restoreSettingsSafely 的白名单
    （1..500 / 1..3600）对齐：PUT /api/settings 能写入的值必须也能被恢复白名单接受，
    否则越界值会在恢复时被整段剥离、用户配置静默回退默认值。
    """

    daily_limit: int = Field(15, ge=1, le=500)
    interval_seconds: list[int] = Field(default_factory=lambda: [45, 120])
    halt_on_risk: bool = True

    @field_validator("interval_seconds")
    @classmethod
    def _check_interval_bounds(cls, v: list[int]) -> list[int]:
        for x in v:
            if not (isinstance(x, int) and 1 <= x <= 3600):
                raise ValueError(f"interval_seconds 每项须为 1~3600 的整数，收到 {x!r}")
        return v


class BrowserConfig(BaseModel):
    """浏览器执行层配置（DrissionPage）。"""

    user_data_dir: str = ""
    headless: bool = False


class BlacklistConfig(BaseModel):
    """黑名单：屏蔽公司 / 屏蔽关键词。"""

    companies: list[str] = Field(default_factory=list)
    keywords: list[str] = Field(default_factory=lambda: ["外包", "猎头", "培训"])


class SecurityConfig(BaseModel):
    """外部链接宿主白名单：允许经系统浏览器打开的域名后缀列表。

    与 electron/main.js 的 security.external_url_hosts 保持一致：
    仅放行 http/https，且宿主必须命中默认白名单（*.zhipin.com）或此处扩展配置，
    其余域名一律拒绝打开，防止外部注入的职位/公司链接把系统浏览器导向钓鱼站。
    """

    external_url_hosts: list[str] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# 顶层配置模型
# ---------------------------------------------------------------------------


class Settings(BaseSettings):
    """全局配置。端口/限额/路径一律从这里读取，禁止硬编码。"""

    model_config = SettingsConfigDict(
        env_prefix="BOSS_",
        env_nested_delimiter="__",
        json_file=SETTINGS_PATH.as_posix(),
        json_file_encoding="utf-8",
        extra="ignore",  # 容忍配置文件中未来新增的未知字段
    )

    # 端口：默认值兜底，实际以 settings.json 为准；区间对齐 constants.PORT_MIN/MAX
    port: int = Field(
        default=DEFAULT_PORT,
        ge=PORT_MIN,
        le=PORT_MAX,
        description="后端 HTTP 监听端口",
    )

    llm: LLMConfig = Field(default_factory=LLMConfig)
    apply: ApplyConfig = Field(default_factory=ApplyConfig)
    browser: BrowserConfig = Field(default_factory=BrowserConfig)
    blacklist: BlacklistConfig = Field(default_factory=BlacklistConfig)
    security: SecurityConfig = Field(default_factory=SecurityConfig)
    cities: list[str] = Field(default_factory=lambda: ["广州", "深圳", "远程"])

    @classmethod
    def settings_customise_sources(
        cls,
        settings_cls: type[BaseSettings],
        init_settings: PydanticBaseSettingsSource,
        env_settings: PydanticBaseSettingsSource,
        dotenv_settings: PydanticBaseSettingsSource,
        file_secret_settings: PydanticBaseSettingsSource,
    ) -> tuple[PydanticBaseSettingsSource, ...]:
        """配置源优先级：初始化参数 > 环境变量 > settings.json。"""
        return (
            init_settings,
            env_settings,
            JsonConfigSettingsSource(settings_cls),
        )


# ---------------------------------------------------------------------------
# DPAPI 静态加密（Windows CryptProtectData / CryptUnprotectData）
#
# 架构 v0.2 安全基线：llm.api_key 仅允许以密文落盘 settings.json，禁止明文持久化。
# - 零第三方依赖，直接经 ctypes 调用系统 crypt32.dll / kernel32.dll。
# - 加密绑定当前 Windows 用户：跨用户/跨机器解密失败时 _decrypt_secret 返回 ""，
#   由用户在设置页重新录入（不抛出、不阻塞启动，比明文外泄更安全）。
# - 非 Windows 平台自动降级为原样存取（不写入 enc: 前缀），避免破坏启动。
# - 密文格式：`enc:<base64(DPAPI密文)>`；空字符串始终原样存储，便于前端
#   「清除已存 Key」提交 '' 后正确落盘。
# ---------------------------------------------------------------------------

_ENC_PREFIX = "enc:"


class _DATA_BLOB(ctypes.Structure):
    """Windows DPAPI 数据块（cbData=字节数, pbData=缓冲区指针）。"""

    _fields_ = [
        ("cbData", ctypes.wintypes.DWORD),
        ("pbData", ctypes.POINTER(ctypes.c_char)),
    ]


def _dpapi_blob_from_bytes(raw: bytes) -> _DATA_BLOB:
    """把 bytes 包装成 DATA_BLOB，供 DPAPI 输入使用。"""
    buf = ctypes.create_string_buffer(raw, len(raw))
    return _DATA_BLOB(len(raw), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char)))


def _dpapi_protect(raw: bytes) -> bytes:
    """CryptProtectData：以当前 Windows 用户凭据加密字节序列，返回密文。"""
    blob_in = _dpapi_blob_from_bytes(raw)
    blob_out = _DATA_BLOB(0, None)
    if not ctypes.windll.crypt32.CryptProtectData(
        ctypes.byref(blob_in), None, None, None, None, 0, ctypes.byref(blob_out)
    ):
        raise OSError("CryptProtectData 失败")
    try:
        return ctypes.string_at(blob_out.pbData, blob_out.cbData)
    finally:
        ctypes.windll.kernel32.LocalFree(blob_out.pbData)


def _dpapi_unprotect(blob: bytes) -> bytes:
    """CryptUnprotectData：解密 DPAPI 密文，返回原始字节。"""
    blob_in = _dpapi_blob_from_bytes(blob)
    blob_out = _DATA_BLOB(0, None)
    if not ctypes.windll.crypt32.CryptUnprotectData(
        ctypes.byref(blob_in), None, None, None, None, 0, ctypes.byref(blob_out)
    ):
        raise OSError("CryptUnprotectData 失败")
    try:
        return ctypes.string_at(blob_out.pbData, blob_out.cbData)
    finally:
        ctypes.windll.kernel32.LocalFree(blob_out.pbData)


try:
    _HAS_DPAPI: bool = bool(
        ctypes.windll.crypt32.CryptProtectData
        and ctypes.windll.crypt32.CryptUnprotectData
    )
except Exception:  # 非 Windows / 系统库缺失 → 降级原样存取
    _HAS_DPAPI = False


def _encrypt_secret(plaintext: str) -> str:
    """空值或 DPAPI 不可用时原样返回；否则返回 `enc:<base64 密文>`。"""
    if not plaintext or not _HAS_DPAPI:
        return plaintext
    try:
        encrypted = _dpapi_protect(plaintext.encode("utf-8"))
    except OSError:
        return plaintext
    return _ENC_PREFIX + base64.b64encode(encrypted).decode("ascii")


def _decrypt_secret(stored: str) -> str:
    """带 `enc:` 前缀则解密回明文；空值/旧明文/解密失败 → 安全返回 ""。"""
    if not stored.startswith(_ENC_PREFIX) or not _HAS_DPAPI:
        return stored
    try:
        blob = base64.b64decode(stored[len(_ENC_PREFIX):].encode("ascii"))
        return _dpapi_unprotect(blob).decode("utf-8")
    except Exception:
        return ""


# ---------------------------------------------------------------------------
# 加载逻辑
# ---------------------------------------------------------------------------


def _write_defaults() -> None:
    """settings.json 缺失时写入默认配置，保证程序首次运行即可启动。"""
    SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
    SETTINGS_PATH.write_text(
        json.dumps(Settings().model_dump(), ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def _sanitize_env_port() -> None:
    """容错 BOSS_PORT 环境变量：非法值（非整数 / 越界）从环境变量中剔除。

    与 electron/main.js 的 resolveBackendPort() 行为保持一致——非法端口优雅忽略，
    交由 settings.json / 默认值兜底，避免 pydantic 在模块导入时抛 ValidationError 崩溃后端。
    """
    raw = os.environ.get("BOSS_PORT")
    if raw is None:
        return
    try:
        value = int(raw)
    except (TypeError, ValueError):
        value = -1
    if not (PORT_MIN <= value <= PORT_MAX):
        os.environ.pop("BOSS_PORT", None)
        print(f"[config] 环境变量 BOSS_PORT={raw!r} 非法，忽略，改用 settings.json / 默认端口。")


def load_settings() -> Settings:
    """加载配置：缺失则先生成默认文件；env 优先于 settings.json 生效。

    settings.json 中的 llm.api_key 以 DPAPI 密文（`enc:` 前缀）持久化，
    读取后在此解密回明文供业务使用（仅驻留内存，不再以明文落盘）。
    """
    _sanitize_env_port()
    if not SETTINGS_PATH.exists():
        _write_defaults()
    loaded = Settings()
    if loaded.llm.api_key.startswith(_ENC_PREFIX):
        loaded.llm.api_key = _decrypt_secret(loaded.llm.api_key)
    return loaded


# ---------------------------------------------------------------------------
# 对外响应（GET /api/settings）敏感字段屏蔽
# ---------------------------------------------------------------------------

# 敏感字段映射：外层键 → 需剔除的内层键。明文 API key 仅存在于后端内部，
# 禁止经未鉴权的 127.0.0.1 接口外发（架构 v0.2 安全基线 / 防御纵深）。
SENSITIVE_SETTING_KEYS: dict[str, tuple[str, ...]] = {
    "llm": ("api_key",),
}


def public_dump(settings_obj: Settings) -> dict:
    """导出对外可公开的配置快照：剔除敏感字段（如 LLM api_key）。

    即使响应模型漏配，路由层也保证 API key 不会出现在响应中。
    """
    data = settings_obj.model_dump()
    for group_key, sensitive_keys in SENSITIVE_SETTING_KEYS.items():
        group = data.get(group_key)
        if isinstance(group, dict):
            for key in sensitive_keys:
                group.pop(key, None)
    return data


def save_settings(payload: dict) -> dict:
    """合并前端回传的公开配置快照，持久化到 settings.json 并刷新生效值。

    前端回传来自 GET /api/settings（api_key / port 已被屏蔽），因此合并时必须
    以当前生效值保留这两个字段：api_key 丢失会导致 LLM 认证失效，port 不应由
    运行中的服务自行变更。合并结果经 Settings 模型校验后整份落盘，随后刷新
    模块级单例，使后续 GET /api/settings 返回保存后的最新值。

    返回与 public_dump() 一致的对外公开快照（敏感字段仍被剔除）。
    """
    global settings
    current = settings.model_dump()
    for key in ("llm", "apply", "browser", "blacklist", "security", "cities"):
        value = payload.get(key)
        if value is None:
            continue
        if isinstance(current.get(key), dict) and isinstance(value, dict):
            current[key] = {**current[key], **value}
        else:
            current[key] = value
    new_settings = Settings(**current)
    SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
    # 落盘副本：llm.api_key 以 DPAPI 密文持久化（`enc:` 前缀），
    # 内存单例 settings 保持明文，后续 GET /api/settings 仍经 public_dump 剔除。
    disk_payload = new_settings.model_dump()
    disk_payload["llm"]["api_key"] = _encrypt_secret(disk_payload["llm"]["api_key"])
    # 保留磁盘上现存但不在 Settings 模型内的顶层键（尤其 electron/main.js 管理的
    # backup 自动备份段）：避免整份重写时静默抹掉这些配置、使其回退默认值。
    try:
        existing = json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
    except Exception:
        existing = None
    if isinstance(existing, dict):
        for key, value in existing.items():
            if key not in Settings.model_fields and key not in disk_payload:
                disk_payload[key] = value
    SETTINGS_PATH.write_text(
        json.dumps(disk_payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    settings = new_settings
    return public_dump(new_settings)


# 模块级单例：供各路由/服务共享同一份配置实例
settings: Settings = load_settings()
