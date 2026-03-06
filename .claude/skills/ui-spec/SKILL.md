# UI Spec Format — Team Convention

用于生成交给 frontend teammate 的 UI 规格文档。
调用方式：`/ui-spec [页面名称或功能描述]`

---

## 你是一个 UI 规格文档编写助手

输出格式严格遵循以下规则：
- 布局用 ASCII 方括号描述
- 流程和架构用 Mermaid 代码块
- 组件状态用 Markdown table
- 数据结构用 YAML 代码块
- 不输出 HTML、JSX 或任何代码
- 不加解释性段落，直接输出规格内容

---

## 1. 信息架构 → Mermaid flowchart

用 flowchart 描述页面关系和导航结构。

```mermaid
flowchart TD
    Home --> ProductList
    ProductList --> ProductDetail
    ProductDetail --> Cart
    Cart --> Checkout
```

---

## 2. 页面布局 → ASCII

用方括号描述区块，斜线或空格表示层级和比例。

```
[Header: Logo | Nav links | CTA button            ]
[Hero: 大标题 / 副标题 / EmailInput + Button       ]
[Features: Card1        | Card2       | Card3      ]
[Footer: Links | Copyright                         ]
```

嵌套结构：

```
[Sidebar 25%          ][Main Content 75%           ]
  - Nav item 1          [Toolbar: Filter | Sort     ]
  - Nav item 2          [Card][Card][Card]
  - Nav item 3          [Card][Card][Card]
```

---

## 3. 组件状态 → Markdown table

| State    | 外观描述                | 触发条件             |
|----------|------------------------|---------------------|
| Default  | 蓝色背景，白色文字      | 初始                |
| Hover    | 深蓝色背景             | 鼠标悬停            |
| Disabled | 灰色背景，不可点击      | 表单未填写完整      |
| Loading  | 显示 spinner，禁用点击  | 提交后等待响应      |

---

## 4. 交互流程 → Mermaid sequenceDiagram

```mermaid
sequenceDiagram
    User->>Form: 填写邮箱
    User->>Button: 点击提交
    Button->>API: POST /subscribe
    API-->>Button: 200 OK
    Button-->>User: 显示成功提示
```

---

## 5. 数据结构 → YAML

```yaml
UserCard:
  props:
    - name: string (required)
    - avatar: url (optional)
    - role: enum[admin, user, guest]
  states: [default, loading, error]
```

---

## 编写约定

- 每个文件对应一个页面或功能模块
- 文件名：`spec-[page-name].md`
- 顺序：信息架构 → 布局 → 组件状态 → 交互流程 → 数据结构
- 不写实现细节，只写意图和约束
- 所有尺寸用相对描述（宽/窄/全宽），不写 px

---

## 输出完成后

1. 将规格文档保存到 `specs/spec-[name].md`
2. **用 AskUserQuestion 向用户确认**，不要直接发给 frontend：

```
AskUserQuestion(
  question="UI 规格已生成：specs/spec-[name].md\n\n视觉排布是否需要调整？",
  options=["确认，发给 frontend", "需要调整（请说明）"]
)
```

3. 用户确认后再执行：
```
SendMessage(to='frontend', message='UI 规格已确认：specs/spec-[name].md，请按规格实现')
```

**未经用户确认，不发给 frontend。**
