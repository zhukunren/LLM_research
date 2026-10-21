#!/usr/bin/env python
"""
测试验证级别设置功能的端到端测试
"""
import sys
import os

# 添加 apps/api 到路径
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'apps', 'api'))

from app.settings import (
    advisor_validation_level,
    set_advisor_validation_level,
    AVAILABLE_VALIDATION_LEVELS
)

def test_validation_settings():
    """测试验证级别设置的所有功能"""
    print("=" * 60)
    print("测试验证级别设置功能")
    print("=" * 60)

    # 1. 测试获取默认级别
    print("\n1. 获取默认验证级别:")
    default_level = advisor_validation_level()
    print(f"   默认级别: {default_level}")
    assert default_level in {"basic", "strict"}, f"意外的默认级别: {default_level}"

    # 2. 测试可用级别列表
    print("\n2. 检查可用验证级别:")
    print(f"   可用级别数量: {len(AVAILABLE_VALIDATION_LEVELS)}")
    for level in AVAILABLE_VALIDATION_LEVELS:
        print(f"   - {level['value']}: {level['label']}")
        print(f"     {level['description']}")
        assert 'value' in level
        assert 'label' in level
        assert 'description' in level

    # 3. 测试设置为严格级别
    print("\n3. 设置验证级别为 'strict':")
    set_advisor_validation_level('strict')
    current_level = advisor_validation_level()
    print(f"   当前级别: {current_level}")
    assert current_level == 'strict', f"设置失败，当前级别: {current_level}"

    # 4. 测试设置为基础级别
    print("\n4. 设置验证级别为 'basic':")
    set_advisor_validation_level('basic')
    current_level = advisor_validation_level()
    print(f"   当前级别: {current_level}")
    assert current_level == 'basic', f"设置失败，当前级别: {current_level}"

    # 5. 测试无效级别
    print("\n5. 测试无效级别 'invalid':")
    try:
        set_advisor_validation_level('invalid')
        print("   错误: 应该抛出 ValueError")
        sys.exit(1)
    except ValueError as e:
        print(f"   正确抛出 ValueError: {e}")

    # 6. 恢复到原始级别
    print("\n6. 恢复到原始级别:")
    set_advisor_validation_level(default_level)
    final_level = advisor_validation_level()
    print(f"   最终级别: {final_level}")
    assert final_level == default_level, f"恢复失败，当前级别: {final_level}"

    print("\n" + "=" * 60)
    print("所有测试通过！")
    print("=" * 60)

if __name__ == "__main__":
    try:
        test_validation_settings()
    except Exception as e:
        print(f"\n测试失败: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
