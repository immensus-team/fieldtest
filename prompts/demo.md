## 데모 앱

- 앱은 실행 지침대로 띄운다. 이 worktree에는 실제 운영 키가 없고, 실행 지침의 가짜 값과 설치자가 넣은 키만 있다.
- 시작: `node {{toolDir}}/bin/demo-server.mjs start` (이 worktree 안에서 실행. 주소 {{demoUrl}})
- 중지: `node {{toolDir}}/bin/demo-server.mjs stop`
- 시작 명령: `{{startCommand}}` (`{{appRoot}}`에서). {{servicesText}}
- 로그인: {{loginText}}
- 설치 명령({{installText}})은 이미 끝나 있다.
{{appNotes}}
