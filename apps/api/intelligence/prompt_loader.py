from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[3]
PROMPT_DIR = PROJECT_ROOT / "prompts"

class PromptNotFoundError(ValueError):

    pass

def list_prompt_keys():

    return sorted(path.stem for path in PROMPT_DIR.glob("*.md") if path.name != "README.md")

def load_prompt(prompt_key):

    safe_key = prompt_key.replace("/", "").replace("\\", "")
    prompt_path = PROMPT_DIR / f"{safe_key}.md"
    if not prompt_path.exists():
        raise PromptNotFoundError(f"Prompt not found: {prompt_key}")
    return prompt_path.read_text(encoding="utf-8")

def render_prompt(prompt_key, variables=None):

    template = load_prompt(prompt_key)
    variables = {key: _stringify(value) for key, value in (variables or {}).items()}
    for key, value in variables.items():
        template = template.replace(f"{{{{{key}}}}}", value)
    return template

def build_system_prompt(prompt_key=None, variables=None):

    system_prompt = load_prompt("system")
    if not prompt_key:
        return system_prompt
    return f"{system_prompt}\n\n---\n\n{render_prompt(prompt_key, variables)}"

def _stringify(value):

    if isinstance(value, str):
        return value
    return repr(value)
